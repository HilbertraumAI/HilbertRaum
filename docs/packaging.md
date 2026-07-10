# Packaging — portable build, sidecars & model weights

_Last updated: 2026-07-10._

This documents **how the app is packaged into a portable build**, **where the runtime binaries and
model weights live on the drive**, and that those artifacts are **not** in the git repository.
The pieces: the runtime-side drive layout; the `electron-builder` portable build +
the `prepare-drive`/`verify-models` scripts; the scripted **asset loader**
(`fetch-models` / `fetch-runtime`) that downloads + verifies the weights and sidecar; and the
**plug-and-play launcher, code signing/notarization, and the `build-commercial-drive`
master pipeline** that produces a finished, sellable drive (see the last section).

## Hard rules (recap)
- **Never commit** model weights, sidecar binaries, user data, embeddings, logs, or generated files
  (CLAUDE.md / spec §0). `.gitignore` already excludes `models/`, `*.gguf`, and `runtime/`.
- The app stays **fully usable offline**. Sidecars bind **`127.0.0.1` only** (loopback); nothing the
  app spawns listens on a routable interface.

## Drive layout (spec §6 — canonical detail in [`drive-layout.md`](drive-layout.md))
```
<drive root>/
  runtime/
    llama.cpp/
      win/    llama-server.exe  (+ DLLs — Vulkan full build, incl. all CPU backends)
              .hilbertraum-runtime.json            (install marker: version/backend/os/arch)
        cpu/  llama-server.exe  (+ DLLs — pure-CPU safety net) + .hilbertraum-runtime.json
      mac/    llama-server      (Metal build) + .hilbertraum-runtime.json
      linux/  llama-server      (Vulkan full build) + .hilbertraum-runtime.json
        cpu/  llama-server      (pure-CPU safety net) + .hilbertraum-runtime.json
    whisper.cpp/
      {win,mac,linux}/  whisper-cli[.exe]  (audio transcriber) + .hilbertraum-runtime.json
  models/
    chat/        qwen3-4b-instruct-q4.gguf  …
    embeddings/  multilingual-e5-small-q8.gguf
    reranker/    transcriber/               (optional reranker GGUF; whisper GGML .bin)
    vision/      qwen2.5-vl-3b-…q4.gguf + mmproj-…f16.gguf   (optional; the LM GGUF + its mmproj projector — TWO files)
  ocr/           {deu,eng}.traineddata.gz   (OCR language files, sha256-verified)
  model-manifests/   (committed YAML — the only model metadata in git)
  workspace/   config/   logs/
```

- **Sidecar binaries** — prebuilt `llama.cpp` `llama-server` executables, one folder per OS. The OS
  sub-dir (`win`/`mac`/`linux`) and the executable name (`llama-server.exe` on Windows, `llama-server`
  elsewhere) are resolved by `resolveLlamaServerPath(rootPath, platform)` in
  `services/runtime/sidecar.ts`. A `HILBERTRAUM_LLAMA_BIN` env var overrides the path for dev.
  - **In-app engine install (`services/runtime-download.ts`).** The same prebuilt binaries the DIY
    `fetch-runtime` scripts provision at build time can also be fetched **from inside the app** (the
    "Install the AI engine" banner on the AI Model screen) when a drive has model weights but no
    engine — otherwise a started model silently falls back to the demo runtime. The installer is
    **engine-family-generic**: `ENGINE_FAMILIES` lists `llama_cpp` (the `llama-server` chat engine)
    and `whisper_cpp` (the `whisper-cli` voice/transcription engine), and a single install fetches
    every missing family for the host. **The banner is scoped per concern (ModelsScreen):** it reads
    `EngineStatus.missingFamilies` and shows the strong *"Install the AI engine — models run in demo
    mode"* **warning only when `llama_cpp` (the chat engine) is missing**; when the chat engine is
    present and only `whisper_cpp` is absent it shows a quiet **info** note (*"Add voice dictation
    (optional)"*) instead — chat already answers for real, so the demo-mode alarm would be false. **To
    add a future engine family:** add its `<family>:` block
    to `model-manifests/runtime-sources.yaml` (with a real host build + SHA-256) and one entry to
    `ENGINE_FAMILIES` (`{ family, binaryBase }`); status, install, flatten, marker, and the banner
    generalize automatically. A family with **no prebuilt host build** (e.g. whisper.cpp on
    macOS/Linux, which ships Windows-only binaries — built from source by the drive builder) is
    simply skipped by the in-app installer.
- **Model weights** — GGUF files under `models/`, resolved from each manifest's `local_path` (relative
  to the drive root) via `weightPath(rootPath, manifest)`. They are **git-ignored**; a real drive is
  built by the prepare-drive scripts (and verified against the manifest `sha256`). The bundled
  Qwen3 + E5 manifests now carry **real pinned hashes**; a model you add yourself starts as a
  `REPLACE_WITH_REAL_HASH` placeholder until you capture it with `verify-models --generate`.
- **Vision models are TWO files sharing one `modelId` (image understanding V1–V5).** A `role: vision`
  manifest names the language GGUF (top-level `local_path`/`sha256`/`download`) **plus** an `mmproj`
  projector sub-block (its own `local_path`/`sha256`/`download`, resolved by `mmprojPath(...)`). The
  download topology is **two already-atomic single-file `DownloadJob`s under one `modelId`** (DIST-1):
  each is `.part`-staged + verify-before-rename by the existing single-file machinery — no cross-file
  progress aggregation, no two-phase verify. **Install = BOTH files present + SHA-256-verified**
  (`computeInstallState`). Vision is **opt-in**: `--with-assets`/`prepare-drive` does NOT fetch it by
  default; `--only <vision-id>` or `--all-models` pulls both files. See
  [`model-policy.md`](model-policy.md) "The vision role + mmproj projector".

## How the app uses them at runtime
- The **runtime factory** (`createSelectingRuntimeFactory`) and the **embedder factory**
  (`createSelectedEmbedder`) each return the **real** backend (`LlamaRuntime` / `E5Embedder`) only when
  **both** the `llama-server` binary **and** the relevant GGUF weights exist; otherwise they fall back
  to the mock. So with an empty `runtime/` + `models/` (the repo's default, and CI), the app launches
  and every test passes on the mocks — the real backends are a drop-in the moment the files appear.
- Both real backends spawn `llama-server` on a random **loopback** port and talk to it over HTTP
  (`/v1/chat/completions` streaming for chat, `/v1/embeddings` for the embedder). The processes are
  killed on `stop()` and on `will-quit` (no orphaned `llama-server`).

## Acquiring the binaries / weights — scripted or manual
The live path needs artifacts **not in the repo**:
- a `llama.cpp` `llama-server` build for your OS (under `runtime/llama.cpp/<os>/`), and
- the GGUF weights named by the manifests (under `models/...`).

**The `fetch-*` scripts automate this** (below) — `prepare-drive --with-assets`
downloads + SHA-256-verifies the artifacts in one command. By default it fetches a small but
complete **default set** — the default **chat** model (Ministral 3 8B), the **embeddings** model,
the **reranker**, and the **Whisper** transcriber model — plus **both sidecar runtimes** (`llama.cpp`
+ `whisper.cpp`), so chat, document Q&A, retrieval quality, and audio work out of the box. The user
grabs any other models (larger chat models) from the app's AI Model screen on demand; add
`-AllModels`/`--all-models` to provision every model up front (the runtimes are fetched either way).
The
whisper.cpp runtime is prebuilt for **Windows only**, so on a macOS/Linux build host `--with-assets`
skips it with a note (build it from source). You can still drop everything in by hand. Then start a
chat model on the AI Model screen to get real on-device inference and real tokens/sec.

## Portable build (electron-builder)

The app is packaged with **electron-builder** (`apps/desktop/electron-builder.yml`). The primary
target is a **portable Windows `.exe`** that launches from an external drive; macOS (`dir`) and
Linux (`AppImage`) targets are defined for architecture parity (spec rule: keep all three
supported), even though only Windows is produced on the current dev machine.

```bash
npm run package        # electron-vite build + electron-builder (current OS targets)
npm run package:win    # build + a Windows portable .exe specifically
```

Key config points:
- **`executableName: HilbertRaum`** is pinned at the top level (PR #30). electron-builder derives
  the per-platform executable / AppImage name from the **npm package name**, which in this monorepo
  is the scoped `@hilbertraum/desktop` → `@hilbertraumdesktop`; the `@` is an unsafe path char that
  electron-builder rejects, so the build fails (first seen on the Linux AppImage target, then mac/win
  once the desktop package was renamed to the scoped name). The explicit `executableName` gives every
  platform a path-safe binary name. **Keep it in sync with `productName`** (both are `HilbertRaum`);
  `tests/integration/packaging.test.ts` asserts they match and that the name carries no `@`.
- **Electron ≥ 37 (Node 22.x)** is required so the packaged main process has `node:sqlite`
  (`electron` is pinned `^37`). A downgraded/stripped runtime would lose it — do not downgrade.
  Because `electron` is pinned as a **range** and hoisted to the repo-root `node_modules`,
  electron-builder 26 cannot auto-detect it from `apps/desktop` — so `electron-builder.yml` pins
  **`electronVersion`** explicitly (keep it in sync with the `electron` devDependency when bumping).
- **Production `dependencies` ship inside `app.asar`** (`pdfjs-dist` / `mammoth` / `jszip` / `papaparse` /
  `yaml` / `@noble/hashes`), so the `require()`s in the parsers, manifest loader, the vault KDF, and the
  same-format DOCX writer resolve at runtime. **`jszip`** was already in the tree transitively under
  `mammoth`; it is now a **direct dependency** (D77) because `services/export/docx-rewrite.ts`
  imports it to rewrite `<w:t>` nodes (pure-JS, no native addon — the closure is unchanged). electron-builder
  26's collector follows **hoisted/nested** `node_modules` trees
  (e.g. mammoth's transitive deps) **by default** — the old `includeSubNodeModules: true` option was
  removed in eb 26 (it now errors as an unknown property) and is no longer needed. `npmRebuild: false`
  (no native addons).
  **These are externalized, so a missing one only fails at RUNTIME, not in the green gate — after
  packaging, smoke-test importing a PDF, a DOCX, and a CSV, AND creating/unlocking an encrypted
  workspace (exercises `@noble/hashes` argon2id), from the produced `.exe`.**
- **The never-imported mermaid chain is excluded from `app.asar`** via `files` negations in
  `electron-builder.yml`: `streamdown` (the chat Markdown renderer) hard-depends on `mermaid`
  (~136 MB unpacked incl. cytoscape / the d3 suite / dagre-d3-es / roughjs), but the
  `@streamdown/mermaid` plugin is not installed, so none of it is ever imported — Vite keeps it out
  of the renderer bundle and the negations keep it out of the asar (app.asar ≈ 68 MB vs ≈ 204 MB
  without). `tests/integration/packaging.test.ts` recomputes the "reachable only via mermaid" set
  from `package-lock.json`, so a future dep that genuinely needs an excluded package turns the green
  gate red (remove that negation then). If the mermaid plugin is ever adopted, delete the negation
  block and its test.
- **`tesseract.js` + `tesseract.js-core` are `asarUnpack`ed**: the OCR engine spawns
  its Node worker via `worker_threads`, which loads the worker script (and the WASM core it
  requires) through real filesystem reads that cannot see inside the asar archive. The engine
  rewrites `app.asar` → `app.asar.unpacked` in the resolved workerPath. **After packaging, also
  smoke-test "Make searchable (OCR)" on a scanned PDF from the produced `.exe`** (same
  runtime-only-failure class as the externalized parsers).
- **`model-manifests/` ship as `extraResources`** (beside `app.asar`). The packaged main process
  finds them via `resolveManifestsDir(app.getAppPath())`, which walks up to `resources/model-manifests`;
  `HILBERTRAUM_MANIFESTS_DIR` overrides. Weights + sidecar binaries + the `ocr/` language files are
  **never** bundled — they live on the prepared drive.
- The build output goes to `apps/desktop/release/` (git-ignored).

### Launching from a drive
Copy the portable `.exe` to the drive root next to the prepared layout, then launch it with
`HILBERTRAUM_DRIVE_ROOT` pointing at the drive root (the drive's launcher sets this; `resolvePaths` keys
off `config/drive.json`). The app then reads `models/`, `workspace/`, `config/`, etc. from the drive.

> ⚠️ **Producing the actual artifact is a MANUAL step (R2/R5).** electron-builder may download the
> platform Electron binary at build time (R2, dev-only network), and a real USB-drive launch with a
> live model needs the weights + sidecar binaries that are not in the repo (R5). With npm workspaces,
> production deps are hoisted to the root `node_modules`; if electron-builder can't collect them,
> build from `apps/desktop` or temporarily disable hoisting. None of this affects `npm test` /
> `typecheck` / `npm run build` (the green gate), which do not invoke electron-builder.

## Module format & renderer bundle — design record (ESM main + code-split)

The TypeScript source is ESM throughout (`module: ESNext`, `moduleResolution: Bundler`, `noEmit`);
only the electron-vite **output** format is a choice. As built:

- **Main process ships ESM** (`out/main/index.mjs`). `electron.vite.config.ts` sets
  `main.build.rollupOptions.output.format: 'es'`; `apps/desktop/package.json` `main` points at the
  `.mjs`. `__dirname` doesn't exist in an ESM module, so `src/main/index.ts` and
  `services/ocr/rasterizer.ts` reconstruct it via `dirname(fileURLToPath(import.meta.url))` (the same
  idiom the test suite already uses). `db.ts`'s `createRequire(process.execPath)` for `node:sqlite`
  is unaffected (createRequire is the ESM-native escape hatch).
- **Preload STAYS CommonJS** (`out/preload/index.js`, `ocr.js`). This is not an oversight: Electron
  only supports ESM preload scripts when `sandbox: false`, and both windows deliberately run
  `sandbox: true` (spec §0 / "Process model & security"). So `format: 'es'` is scoped to `main`
  only, and `"type": "module"` is **NOT** set on the package (which would force `.js` → ESM and break
  the CJS preload). A "pure ESM" app is therefore not reachable while sandboxed — main-ESM +
  preload-CJS is the end state. Main still references `../preload/index.js` (CJS) at runtime.
- **Tree-shaking** keys off the ESM *input* graph, which was already ESM — so the ESM-output flip
  buys none of it. `package.json` carries `"sideEffects": ["*.css"]` so Rollup may drop unused
  exports from our own modules while preserving the side-effectful CSS imports.
- **Renderer code-split (the actual bundle win).** `streamdown` + `katex` + `@streamdown/math`
  (~2 MB) were eager in the initial renderer chunk because `AssistantMarkdown` — used on the chat,
  translate, documents-preview, and images screens — statically imported them. `AssistantMarkdown`
  now lives in its own module (`src/renderer/chat/AssistantMarkdown.tsx`) behind a `React.lazy`
  wrapper (`AssistantMarkdownLazy.tsx`, re-exported as `AssistantMarkdown` from the chat barrel), so
  that weight loads as a **separate async chunk on first answer render**. Initial `index-*.js`:
  **3,196 kB → 1,194 kB (−63%)**. The async chunk is Vite-named `mermaid-*` after a streamdown
  internal module but contains only streamdown+katex — no real mermaid/cytoscape/d3 (still excluded
  from the asar, see the mermaid negation above). The fallback renders the raw text in a `.md`
  container during the (local, offline, few-ms) load — no blank flash. Tests render markdown
  synchronously: `vitest.config.ts` aliases `./AssistantMarkdownLazy` → the real component so render
  assertions don't have to await Suspense.
- **Route-level code split (full-audit 2026-07-10 PF-6).** Six screens — Documents, Settings,
  Models, Images, Skills, Translate — are `React.lazy` in `App.tsx`, each a separate async chunk
  fetched on first navigation. Initial `index-*.js`: **1,255 kB → 998 kB (−20.5%)**; the split-out
  chunks are DocumentsScreen 124 kB, SettingsScreen 41 kB, ModelsScreen 31 kB, ImagesScreen 27 kB,
  SkillsScreen 24 kB, TranslateScreen 15 kB. Deliberately **eager**: the workspace gate + HomeScreen
  (the first frame) and ChatScreen — Chat is the primary surface (first-run lands there), and
  splitting it would pull the shared chat components out of the initial chunk, which this record
  keeps as an explicitly separate decision (same for the two i18n catalogs, the other big initial
  resident — unminifiable string tables). The suspense point is a quiet localized `.screen`
  fallback inside the existing per-screen ErrorBoundary (a failed chunk import lands on the
  boundary's localized retry fallback); `tests/renderer/LazyScreens.test.tsx` pins the
  fallback → content sequence. The −30% aspiration of the finding is therefore not reached
  screens-only; the remaining headroom is exactly those two exclusions.

## Preparing a drive — scripts

`scripts/` provisions and verifies a drive. The scripts are **self-contained** (a drive can be laid
out on a fresh machine with no Node/npm); their layout + config shapes mirror the unit-tested
`apps/desktop/src/main/services/drive.ts` (the canonical reference — keep them in sync).

| Script | Purpose |
|---|---|
| `prepare-drive.{ps1,sh}` | Create the directory tree, copy manifests + **the committed `app-skills/` product skills** (wholesale, like manifests — S9; `user-skills/` is left empty) + user docs, generate `config/{drive,policy}.json`. `-DryRun`/`--dry-run` prints the plan. `-Dev`/`--dev` → a plaintext developer drive. **`-WithAssets`/`--with-assets`** then runs `fetch-models` + `fetch-runtime` (forwarding `-AcceptLicense`/`--accept-license`) for a launch-ready drive — by default fetching a small **default set** (chat model Ministral 3 8B + embeddings + reranker + Whisper transcriber) **plus both sidecar runtimes** (`llama.cpp` + `whisper.cpp`, the latter Windows-only/best-effort); **`-AllModels`/`--all-models`** fetches every model instead (runtimes either way). |
| `fetch-models.{ps1,sh}` | Download + **resume** + **SHA-256-verify** each weight with a `download:` block to its `models/...` path. `-Only <id>`/`--only` for one model; `-AcceptLicense`/`--accept-license` for the license gate; `-DryRun`/`--dry-run`. Real-hash mismatch → delete partial + exit 1. Idempotent (present + verified → skip). |
| `fetch-runtime.{ps1,sh}` | Read `runtime-sources.yaml`, pick the host build (`-Os/-Arch/-Backend` overrides; **default = the first listed build: Vulkan on win/linux, Metal on mac**; `-Backend cpu` fetches the pure-CPU safety net into `runtime/llama.cpp/<os>/cpu/`), download + verify the archive, extract into the build's `extract_to` (`chmod +x` on mac/linux), and write a `.hilbertraum-runtime.json` install marker. Idempotent **via the marker** (version + backend must match — a missing/stale marker re-fetches, so a CPU-era drive actually upgrades); `-DryRun`/`--dry-run`. `-Family`/`--family` selects the asset family: `llama_cpp` (default), `whisper_cpp` (the transcriber CLI), or `ocr` (language files). |
| `verify-models.{ps1,sh}` | SHA-256 each present weight vs its manifest hash (placeholder → *UNVERIFIED*; real mismatch → fail/exit 1). `-Generate`/`--generate` writes `config/checksums.json`. |
| `setup-dev.{ps1,sh}` | Dev bootstrap: `NODE_OPTIONS=--use-system-ca npm install` (R6, set only when Node ≥ 22.15 supports the flag; skipped gracefully otherwise) + build + test smoke. |
| `verify-electron.mjs` | Root **`postinstall`** (runs on every `npm install`). Verifies Electron's platform binary actually extracted; force-re-extracts from the cached download when a half-extract is detected (the silent NTFS-on-Linux `extract-zip` failure), else fails with an actionable message instead of leaving the opaque electron-vite `Electron uninstall` error for later. Cross-platform Node (not a shell mirror). Skips via `ELECTRON_SKIP_BINARY_DOWNLOAD` / `ELECTRON_OVERRIDE_DIST_PATH` / `HILBERTRAUM_SKIP_ELECTRON_CHECK`. |

The asset **download / verify / plan** logic is mirrored from the unit-tested
`apps/desktop/src/main/services/assets.ts` (the canonical reference for *that* logic — keep in sync),
exactly as `prepare-drive` mirrors `drive.ts`. **The default-set model-id list itself, however, is
NOT in `assets.ts`**: it lives only in `scripts/prepare-drive.ps1`
(`$DefaultModelIds`) and `scripts/prepare-drive.sh` (`DEFAULT_MODEL_IDS`), and must be kept in sync
**between those two shells** and with the manifests under `model-manifests/` — editing `assets.ts`
does not change which models `--with-assets` fetches (a parity test,
`tests/unit/prepare-drive-default-set.test.ts`, asserts the two shells' lists match). (`scripts/` also holds two **benchmark/RAM-calibration** helpers
that are NOT part of drive prep — `benchmark-speed.ps1` (decode speed) and `measure-peak-rss.ps1`
(co-resident peak RSS); see [`model-benchmarks.md`](model-benchmarks.md) for how they are run.) The scripts use the **OS-native downloader** (`curl` /
`Invoke-WebRequest`) — no new npm/script deps. The `fetch-models` scripts additionally prefer
`aria2c` when it is installed; `fetch-runtime` uses `curl`/`Invoke-WebRequest` only.

**Resilient downloads (flaky-connection hardening).** `curl`'s own `--retry` does not retry a
**mid-transfer drop** (exit 18/56/28) on older curl, so a beta tester whose link dropped during a
`curl` lost the whole download. Every `curl` call now goes through a small wrapper
(`Invoke-CurlResilient` in the `.ps1` scripts, `curl_resilient` in the `.sh` scripts) that runs an
**outer retry loop** (5 attempts, growing back-off) and **resumes the partial file** with `-C -` on
each attempt — so a download survives several disconnects rather than restarting from zero. Per-call
flags were also strengthened: `--retry 3 --retry-delay 2 --retry-connrefused --connect-timeout 30`
(all available on the curl that ships with Win10 1803+/git-bash). Integrity is still enforced by the
**SHA-256 pin AFTER download**, so resuming a partial transfer can never weaken verification. `aria2c`
(when present) already resumes via `--continue=true`; `wget` via `-c`.

End-to-end (Windows example). `-WithAssets` alone provisions the default chat model for a fast,
launch-ready drive; add `-AllModels` to pre-load every model (a fully provisioned commercial drive):
```powershell
.\scripts\prepare-drive.ps1 -Target E:\ -WithAssets -AllModels -AcceptLicense  # layout + download + verify (all models)
.\scripts\verify-models.ps1 -Target E:\ -Generate                              # record real hashes
npm run package:win                                                            # build the portable .exe
copy ".\apps\desktop\release\HilbertRaum-*-portable.exe" E:\                    # place the launcher on the drive
```

> ✅ **`runtime-sources.yaml` is pinned to a real release** (`ggml-org/llama.cpp` **b9849** — bumped
> from b9585 on 2026-07-01 as the **Qwen3.5 compatibility gate**; real per-OS URLs + SHA-256
> checksums from the official GitHub Releases API `digest` metadata) — `fetch-runtime` downloads,
> verifies, extracts (zip and tar.gz) and flattens the binaries for all three OSes from any host.
> **A real b9849 fetch + a one-old-model / one-Qwen3.5-model load are a REQUIRED manual smoke** (it
> cannot run in offline CI; see BUILD_STATE "Qwen3.5 Unsloth wave" and `model-benchmarks.md` §9).
> The win/linux default is the **Vulkan full build** (GPU acceleration with
> built-in CPU degradation) plus a pure-CPU safety net at `runtime/llama.cpp/<os>/cpu/` — see
> [`drive-layout.md`](drive-layout.md) and the [`architecture.md`](architecture.md) GPU record.
> The chat/embeddings **model** URLs are real Hugging Face links and the bundled manifests now carry
> **real pinned `sha256` hashes** (captured from verified downloads via `verify-models --generate`);
> a model you add yourself stays `REPLACE_WITH_REAL_HASH` until you capture its hash the same way.
> To bump the runtime pin later, see [`model-policy.md`](model-policy.md).

Or the older manual flow (no download): `prepare-drive` (no `-WithAssets`) → drop GGUF weights into
`E:\models\…` + `llama-server` into `E:\runtime\llama.cpp\win\` by hand → `verify-models -Generate`.

> **Build-time network ≠ runtime network.** The `fetch-*` scripts make the project's first
> deliberate network access, but they run on the **builder's** machine at build time. The app stays
> 100% offline by default; the in-app downloader is triple-gated (policy ceiling ∧ user setting ∧
> per-download confirmation) and downloads are policy-permitted in both `prepare-drive` postures —
> update checks + telemetry stay denied, matching the commercial final check below (gate
> semantics: [`model-policy.md`](model-policy.md) "The in-app downloader"). This does not weaken
> the offline guarantee.

These artifacts (weights, sidecar binaries, the workspace DB, logs, the portable `.exe`) are all
**git-ignored** — they live on the drive, never in the repo.

## Plug-and-play commercial drive

A non-technical buyer must be able to **plug in, double-click one icon, and chat** — no Docker, no
installer, no terminal. The chosen mechanism is the **portable bundled app + a tiny native
launcher**:

| Approach | Plug-and-play for a non-technical buyer? | Verdict |
|---|---|---|
| **Docker container** | ❌ Needs Docker Desktop (multi-GB install, admin rights, daemon, paid for larger orgs); GPU passthrough painful on Win/Mac | **Rejected** |
| **System installer** (`.msi`/`.pkg`) | ⚠️ Admin rights, writes to the host, breaks "your data lives on the drive, move it between laptops" (success criterion #10) | **Rejected as default** |
| **Portable bundled app on the drive** (electron-builder `portable` + launcher) | ✅ Plug in → double-click → runs; nothing written to the host; drive movable | **Chosen** |

The classic portable-Electron pitfall (settings leaking into `%APPDATA%`) does not apply:
`resolvePaths()` redirects **all** state (workspace DB, logs, config, models) onto the drive.
First-run polish is `services/preflight.ts` (writable/free-space/slow-drive checks, friendly +
non-blocking, surfaced on Home); encrypted-by-default onboarding is kept.

### The launcher (sets `HILBERTRAUM_DRIVE_ROOT` from its OWN location)

The drive root ships an obvious, double-clickable launcher (spec §6 names). Source templates live in
`launchers/` and are copied to the drive root by the pipeline:

| OS | File | What it does |
|---|---|---|
| Windows | `Start HilbertRaum.cmd` | `%~dp0` → drive root → set `HILBERTRAUM_DRIVE_ROOT` → spawn the portable `.exe`. |
| macOS | `Start HilbertRaum.command` | `cd "$(dirname "$0")"` → export `HILBERTRAUM_DRIVE_ROOT` → exec the `.app` binary. |
| Linux | `start-hilbertraum.sh` | same, next to the AppImage. |
| all | `READ ME FIRST.txt` | friendly first-run + SmartScreen/Gatekeeper instructions. |

> ⚠️ **No hardcoded paths — drive letters change per machine.** The launcher derives the root from
> **its own location every launch** (`%~dp0` / `dirname "$0"`), so the same drive works on a second
> laptop with a different letter/mount and continues the **same encrypted workspace** (success
> criterion #10). The canonical, unit-tested reference is
> `apps/desktop/src/main/services/launcher.ts` `resolveDriveRootFromLauncher`; the scripts mirror it.
>
> **Autorun is dead.** Windows disabled `autorun.inf` from removable drives, so the app **cannot**
> auto-launch on plug-in (and must not try — it looks like malware). The drive opens a file window and
> the buyer double-clicks the well-named launcher.

### Code signing & notarization (the make-or-break, mostly-manual task)

An unsigned `.exe`/`.app` launched from USB trips **Windows SmartScreen** / **macOS Gatekeeper**, and
a non-technical user gives up. The `electron-builder.yml` hooks are wired but **driven entirely by env
vars / a git-ignored secrets file on the build machine — secrets NEVER enter the repo**, and **the
green gate does not sign** (it never invokes electron-builder).

- **Windows** (`win.signtoolOptions`): supply the OV/EV cert via `WIN_CSC_LINK` (path/URL to the
  `.pfx` or base64) + `WIN_CSC_KEY_PASSWORD`. **EV** certs (hardware token / cloud HSM) build
  SmartScreen reputation fastest. The launcher `.cmd` is a script (not signed); the portable `.exe` it
  spawns **is** signed — that is what SmartScreen evaluates.
- **macOS** (`mac.notarize` + `hardenedRuntime` + `build/entitlements.mac.plist`): supply the
  *Developer ID Application* cert via `CSC_LINK`/`CSC_KEY_PASSWORD` and the notarization creds via
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. electron-builder auto-notarizes when
  those are present. **Without notarization a USB-launched `.app` is quarantined.**
- **Unsigned DIY fallback** ("More info → Run anyway" / right-click → Open) is documented in
  `docs/troubleshooting.md` — acceptable for technical users, **not** for the commercial drive.
- `.gitignore` excludes `*.pfx`/`*.p12`/`*.cer`/`*.key`/`signing.env`/`*.provisionprofile`.
- **Procurement risk R7:** code-signing certs (esp. EV / Apple Developer) cost money + lead time, and
  block only the **commercial** acceptance, not the DIY path.

### The `build-commercial-drive` master pipeline

One self-contained, dual-shell script (`scripts/build-commercial-drive.{ps1,sh}`) runs the ordered
steps. Its plan + the final "is this sellable?" assertion are mirrored from the canonical, unit-tested
`apps/desktop/src/main/services/commercial-drive.ts` (`planCommercialDrive` + `assertCommercialDrive`).

```
prepare-drive  --force            # commercial policy (encrypted, plaintext off, no phone-home)
fetch-models   --accept-license   # verified weights (a SOLD drive needs an approved, redistributable license — spec §13)
fetch-runtime                     # verified llama.cpp sidecar builds: per OS the default (Vulkan/Metal)
                                  # + the pure-CPU safety net on win/linux
package + sign + notarize         # MANUAL — secrets never in the repo (pass --app-artifact / --skip-package)
copy launcher + portable app + user docs -> drive root
verify-models  --generate         # capture real hashes -> config/checksums.json
final check: commercial posture (encrypted, no phone-home — downloads OK, update-checks + telemetry denied) + all weights VERIFIED
             + runtime install markers match the pin + no user data
             + app skills provisioned (app-skills/) + user-skills/ empty (Skills S9)
```

```powershell
# Windows (supply a pre-built, signed .exe; or --skip-package to assemble + sign yourself)
.\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -AppArtifact .\apps\desktop\release\HilbertRaum-0.1.0-portable.exe
.\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -DryRun        # print the plan
```
```bash
# macOS / Linux
scripts/build-commercial-drive.sh --target /Volumes/HILBERTRAUM --accept-license --app-artifact ./apps/desktop/release/HilbertRaum.app
```

The final automated check asserts the **commercial posture** (`policy.json`: encryption required,
plaintext off, models must verify, **no phone-home** — model downloads are a permitted user action,
but update-checks + telemetry are denied) **and** that **every weight is VERIFIED** **and**
that **no user data is present** (spec §12.2) **and** that **at least one trusted product skill is
provisioned under `app-skills/` while `user-skills/` ships empty** (Skills S9) — the canonical gate is
`assertCommercialDrive(...)`; the scripts add a native cross-check of the same invariants. **"Every
weight VERIFIED" spans every shipped runtime family (2026-07-01):** the verifier + `verify-models.{ps1,sh}`
gate on the canonical `(runtime → format)` support table (`models.ts` `SUPPORTED_RUNTIME_FORMATS`), so the
bundled **ggml / whisper_cpp** transcriber verifies by SHA-256 like any GGUF — previously it was reported
`UNSUPPORTED`, which meant a drive that bundles Whisper could never pass `-Strict` / the sell gate.
**Remaining manual acceptance (R5/R7):** a
real signed build + notarization + a USB-drive §17 demo on a fresh laptop with Wi-Fi off, and the
second-laptop continuity check.

## Continuous integration (CI) — the automated green gate

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the **exact pre-release command
chain** — `npm ci` → `npm run typecheck` → `npm run build` → `npm test` — on every pull request
and on pushes to `master`, across a matrix of **`ubuntu-latest` and `windows-latest`** (Windows is
first-class for this project) on **Node 22.x** (engines require `>=22.5`). It is the machine
backstop the audit asked for (TEST-N1): before CI, the suite was green only by author discipline,
and the repo's own anti-false-green check ([`tests/full-suite-guard.ts`](../apps/desktop/tests/full-suite-guard.ts))
only mattered if something ran it. CI runs the two per-OS matrix legs (`build-and-test
(ubuntu-latest)` / `(windows-latest)`) plus a tiny **`ci-success`** aggregate job that passes only
when both legs pass — mark **`ci-success`** the **required status check** on `master`. Its name is
stable even if the OS matrix labels change later, so branch protection never silently stops matching.

**Why it can run with zero weights / zero network / zero binaries:** the unit + integration suite
is offline by construction — mock runtime, mock embedder, `electron` mocked — and nothing in
`typecheck`/`build`/`test` launches Electron. So CI sets two env knobs to skip the ~100 MB Electron
platform-binary download and the repo's `verify-electron` postinstall (which only guards the
dev-time NTFS half-extract bug):

| Env var (CI only) | Effect |
| --- | --- |
| `ELECTRON_SKIP_BINARY_DOWNLOAD=1` | Electron's own postinstall skips the platform-binary download. |
| `HILBERTRAUM_SKIP_ELECTRON_CHECK=1` | [`scripts/verify-electron.mjs`](../scripts/verify-electron.mjs) early-exits (it also early-exits on the var above). |

npm downloads are cached via `actions/setup-node` (`cache: npm`, keyed off the root
`package-lock.json`); `concurrency: cancel-in-progress` cancels a superseded run when a branch/PR
is pushed again. All third-party actions in `ci.yml` **and** `release.yml` are pinned to **full
commit SHAs** with a `# vX.Y.Z` comment (the `cla.yml` idiom — a movable tag like `@v4` would let
a compromised action repo inject code into CI; full-audit 2026-07-10 SC-1). This is **dev infrastructure only** — it ships nothing to users, adds no
telemetry/analytics, and performs no network egress beyond the registry install (the "no cloud /
no telemetry" hard rule governs the shipped app at runtime).

**What CI does NOT cover — the manual `HILBERTRAUM_*` matrix stays a separate human gate.** A green
CI run says **nothing** about the real-`spawn` / real-binary / real-weights surface: that is the
`HILBERTRAUM_*` manual harness matrix below (audit M-A5), which is env-gated and skips in CI. CI is
the automated floor; the manual pre-ship checklist and harness matrix remain a required, human-run
pre-release gate. The two do not substitute for each other.

### The release workflow — `release.yml` (tag-triggered prebuilt packages)

One workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml), builds and
draft-publishes the prebuilt packages (it supersedes the earlier `mac-build`/`win-build` pair;
ad-hoc builds = its `workflow_dispatch` trigger, which runs the build legs but skips the tag-gated
release job). **Trigger:** a push of a `v*` tag (or manual dispatch). **Four jobs:**

- **`build-win`** — `windows-latest`: `npm ci` → typecheck → **the full test suite** (once, on the
  first-class OS — belt-and-braces on the exact tagged commit) → `npm run package:win` →
  `HilbertRaum-<version>-portable.exe`.
- **`build-mac`** — `macos-14` (Apple Silicon): `npm ci` → typecheck → `npm run package` (`dir`
  target) → **ad-hoc sign** (`codesign --force --deep --sign -`, required to launch on Apple
  Silicon) → **ditto-zip** (`HilbertRaum-<version>-mac-arm64.app.zip` — it must STAY zipped on
  exFAT, which can't hold the `.app`'s framework symlinks; the drive launcher extracts to a local
  cache). Also fetches the mac Metal runtime via `scripts/fetch-runtime.sh` and zips it with
  symlinks **dereferenced** (`llama-runtime-mac-arm64.zip`) so it drops straight onto exFAT under
  `runtime/llama.cpp/mac/`.
- **`build-linux`** — `ubuntu-latest`: `npm ci` → typecheck → `npm run package` →
  `HilbertRaum-<version>.AppImage` (community-tested until the GPU-matrix Linux leg runs).
- **`release`** (tag-gated, needs all three) — asserts **tag == `apps/desktop/package.json`
  version** (fail fast on mismatch), aggregates `SHA256SUMS.txt`, builds the release notes from the
  CHANGELOG `[Unreleased]` block (prefixed with the "this download is the app only — models are
  fetched separately" line), and creates a **DRAFT** GitHub release (`prerelease: true` while 0.x)
  with everything attached.

**The ritual is draft → owner smoke → publish.** The workflow never publishes: the owner downloads
the draft's artifacts, runs the applicable "Manual pre-ship checklist" below (at minimum item 1 —
the post-package smoke — plus an OCR run and model start/stop with no orphaned `llama-server`),
then clicks **Publish**. A failed smoke → delete the draft, fix, re-tag. A bad build never becomes
publicly linkable.

**Signing posture — staged, all via env secrets (no repo change when certs arrive):**

| Stage | Secrets (GitHub Actions → the env `electron-builder.yml` reads) | Result |
| --- | --- | --- |
| 0 — now | none | unsigned `.exe` (SmartScreen "More info → Run anyway"), ad-hoc-signed `.app` (macOS 15+: System Settings → Privacy & Security → "Open Anyway"), `SHA256SUMS.txt` as the integrity floor — flows documented in [`troubleshooting.md`](troubleshooting.md) |
| 1 — Apple | `CSC_LINK` / `CSC_KEY_PASSWORD` + `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Developer ID-signed + notarized `.app` (electron-builder auto-notarizes; `hardenedRuntime` + entitlements already wired). Also remove the `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` line from `release.yml` |
| 2 — Windows | `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (OV/EV `.pfx` or Azure Trusted Signing via signtool env) | signed `.exe`; SmartScreen reputation builds |

Non-clash with `ci.yml`: `release.yml` never fires on `pull_request`/`push: master` — only tags and
manual dispatch. It runs on **Node 24** (electron-builder ships its own pinned Electron runtime)
vs `ci.yml`'s Node 22.x, does **not** set the `ELECTRON_SKIP_BINARY_DOWNLOAD` knobs (packaging
needs the binary), and installs with `npm ci` (lockfile-pinned — the CI half of hardening L-8).

## Manual pre-ship checklist (real hardware — not covered by CI)

The green gate (`typecheck`/`test`/`build`) runs on mocks with zero weight files, so real-runtime /
real-drive behaviour never shows up in CI. Before any drive ships (commercial or a DIY hand-off),
run one real-model session covering:

1. **Post-package smoke on the produced `.exe`:** import a PDF, a DOCX, and a CSV; create + unlock
   an encrypted workspace (exercises the externalized parser libs and `@noble/hashes` argon2id,
   which only fail at runtime if packaging missed them).
2. **Switch models mid-load and quit mid-load** — confirm no orphaned `llama-server` process
   survives (Task Manager / `ps`).
3. **Import a 50+-page DOCX**, and **lock the workspace during an import** — confirm the import
   stops cleanly and the stuck rows are re-indexable after unlock.
4. **A > 2 GiB workspace:** lock/unlock round-trip (exercises the streaming file crypto + chunked
   shred).
5. **Models / Chat screen latency** with real multi-GB GGUFs on the drive (exercises the checksum
   cache — screens must not re-hash weights per navigation).
6. **The spec §17 USB demo** on a fresh laptop with Wi-Fi off, plus the **second-laptop
   continuity check** (same encrypted workspace under a different drive letter/mount).
7. **The GPU hardware matrix** (canonical list in BUILD_STATE §5): discrete
   NVIDIA/AMD happy paths, Iris-Xe-only laptop (no profile bump), no-GPU/RDP silent CPU,
   pre-Vulkan-1.2 degradation, the mid-generation driver-crash auto-fallback, and the
   machine-move re-probe (1↔4). Measured tok/s feed the release notes.
8. **(If a vision model ships)** open **Images**, analyze a **PNG** and a **JPEG** from the
   produced `.exe` (the `vision-smoke` harness covers the runtime mechanics; this is the
   packaged-app pass) and confirm the calm unavailable state on a drive with **no** vision model.

### The `HILBERTRAUM_*` manual harness matrix — a REQUIRED pre-release gate (audit M-A5)

The riskiest integration surface — real `spawn`, the llama-server SSE stream, GPU
`--list-devices` parsing, whisper-cli, WASM OCR, real weights, real retrieval quality —
is **deliberately not in CI** (the zero-binary / zero-network green-gate posture, audit
M-A5). It is covered instead by the `tests/manual/*.test.ts` harnesses, each gated behind
a `HILBERTRAUM_*` env var that points at a provisioned drive / binary / model. They are skipped
unless that env var is set, so a green CI run says nothing about them.

**Before any drive ships, run the applicable subset against the real artifacts** (a locally
provisioned smoke drive with a llama.cpp binary + a small chat GGUF; see BUILD_STATE).
Treat this as part of the gate, not optional polish. **NOTE (2026-07-01):** the runtime pin
moved to **b9849**, so re-run `fetch-runtime` on the smoke drive to refresh the binary before
these harnesses prove the *current* pin (the drive's previous binary was b9585).

| Harness | Env var(s) | Proves |
| --- | --- | --- |
| `bringup-smoke` | `HILBERTRAUM_BRINGUP_SMOKE` | the runtime starts + streams against the real binary |
| `gpu-smoke` | `HILBERTRAUM_GPU_SMOKE` | rung-1 GPU start, forced-CPU rung, rung-3 safety net |
| `thinking-smoke` / `gemma-thinking` | `HILBERTRAUM_THINKING_SMOKE` / `HILBERTRAUM_GEMMA_THINKING` | deep-mode reasoning channel |
| `rerank-smoke` | `HILBERTRAUM_RERANK_SMOKE` | the reranker sidecar reorders retrieval |
| `whisper-smoke` / `dictation-smoke` | `HILBERTRAUM_WHISPER_SMOKE` / `HILBERTRAUM_DICTATION_SMOKE` | whisper-cli transcription + dictation |
| `ocr-smoke` | `HILBERTRAUM_OCR_SMOKE` | WASM OCR over a real scan |
| `vision-smoke` | `HILBERTRAUM_VISION_SMOKE` | the vision sidecar (`--mmproj`) cold-starts, analyzes a fixture image, streams, reuses the prefill, idle-tears-down + cold-restarts |
| `compare-smoke` | `HILBERTRAUM_COMPARE_SMOKE` | the compare doc-task pipeline end-to-end (the earlier chat-model `translation-smoke` went away with that pipeline; `translategemma-smoke` below covers translation) |
| `translategemma-smoke` | `HILBERTRAUM_TRANSLATEGEMMA_SMOKE` | the TranslateGemma sidecar (NO `--jinja`, raw `/completion`) LOADS on the pin (Vulkan **and** CPU safety-net), DE↔EN translates, keeps invoice numbers/model codes verbatim (numbers/dates localize), resists embedded-instruction injection, leaks no `<end_of_turn>`; prints tokens/sec + peak RSS. **The TG-2 go/no-go gate** — since TG-3 the doc-task's production translation backend. **Extended at TG-6:** per-language round-trip + verbatim-token check for the curated 10, `/tokenize` tokens-per-word (the planner-constant calibration), and a co-residency-RSS leg (translation + E5 + a resident chat, needs `models/{embeddings,chat}/*.gguf`). CPU-safety-net leg needs `runtime/llama.cpp/<os>/cpu/` |
| `rag-quality` / `minsim-measure` | `HILBERTRAUM_RAG_QUALITY` / `HILBERTRAUM_MINSIM_MEASURE` | retrieval quality + the similarity floor |
| `server-concurrency-probe` | `HILBERTRAUM_CONCURRENCY_PROBE` | the one-at-a-time sidecar invariant |
| `model-eval` | `HILBERTRAUM_MODEL_EVAL` | the model-recommendation ladder on real hardware |

**Optional harness *inputs* (point a harness at a specific artifact).** Distinct from the on-switch
env vars in the table above, several harnesses additionally read an **artifact-pointer input**,
documented before only as inline test-file comments. All are
optional — each has a default or is only needed by its harness:

| Input var | Read by | Points at |
| --- | --- | --- |
| `HILBERTRAUM_SMOKE_MODEL` | `bringup-smoke` / `gpu-smoke` / `thinking-smoke` | one chat-model `.gguf` filename (else the smallest chat model) |
| `HILBERTRAUM_GEMMA_MODEL` | `gemma-thinking` | the Gemma model filename (default `gemma4-12b-it-qat-q4.gguf`) |
| `HILBERTRAUM_OCR_IMAGE` | `ocr-smoke` | a real German scan image (png/jpg) — **never committed** |
| `HILBERTRAUM_REAL_MODEL_PATH` | `real-model/wave3` | the chat GGUF path (default `D:/models/chat/qwen3.5-4b-ud-q4kxl.gguf`; sibling `HILBERTRAUM_LLAMA_BIN` points at the binary) |
| `HILBERTRAUM_RESIDENT_REAL_N` | `resident-cache-real` | real chunk count to embed (default 2000) |
| `HILBERTRAUM_EVAL_DIR` | `model-eval` | override the `eval/` data dir |

**Canned-real-output regression-fixture policy:** because these never run in CI, an
upstream format change (SSE shape, `--list-devices` lines, whisper JSON) would otherwise
slip past the green gate and only surface on real hardware. So **whenever a `HILBERTRAUM_*` run
observes an upstream output format change — or a new format worth pinning — capture the
verbatim real output into `apps/desktop/tests/fixtures/` and assert a pure parser against
it in a CI unit test** (the bytes are kept binary via `.gitattributes`). The first such
fixture is the b9585 `--list-devices` capture parsed by `gpu.test.ts` (audit L19); add SSE
and whisper-JSON fixtures the same way as those formats are observed.
