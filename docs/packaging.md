# Packaging — portable build, sidecars & model weights

_Last updated: 2026-06-12 (docs housekeeping: absorbed the Phases-12/13 distribution decision record)_

This documents **how the app is packaged into a portable build**, **where the runtime binaries and
model weights live on the drive**, and that those artifacts are **not** in the git repository.
Phase 10 introduced the runtime-side layout; Phase 11 added the `electron-builder` portable build +
the `prepare-drive`/`verify-models` scripts; Phase 12 adds the scripted **asset loader**
(`fetch-models` / `fetch-runtime`) that downloads + verifies the weights and sidecar; **Phase 13**
adds the **plug-and-play launcher, code signing/notarization, and the `build-commercial-drive`
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
  ocr/           {deu,eng}.traineddata.gz   (OCR language files, sha256-verified)
  model-manifests/   (committed YAML — the only model metadata in git)
  workspace/   config/   logs/
```

- **Sidecar binaries** — prebuilt `llama.cpp` `llama-server` executables, one folder per OS. The OS
  sub-dir (`win`/`mac`/`linux`) and the executable name (`llama-server.exe` on Windows, `llama-server`
  elsewhere) are resolved by `resolveLlamaServerPath(rootPath, platform)` in
  `services/runtime/sidecar.ts`. A `HILBERTRAUM_LLAMA_BIN` env var overrides the path for dev.
- **Model weights** — GGUF files under `models/`, resolved from each manifest's `local_path` (relative
  to the drive root) via `weightPath(rootPath, manifest)`. They are **git-ignored**; a real drive is
  built by Phase 11's prepare-drive scripts (and verified against the manifest `sha256`). The bundled
  Qwen3 + E5 manifests now carry **real pinned hashes**; a model you add yourself starts as a
  `REPLACE_WITH_REAL_HASH` placeholder until you capture it with `verify-models --generate`.

## How the app uses them at runtime (Phase 10)
- The **runtime factory** (`createSelectingRuntimeFactory`) and the **embedder factory**
  (`createSelectedEmbedder`) each return the **real** backend (`LlamaRuntime` / `E5Embedder`) only when
  **both** the `llama-server` binary **and** the relevant GGUF weights exist; otherwise they fall back
  to the mock. So with an empty `runtime/` + `models/` (the repo's default, and CI), the app launches
  and every test passes on the mocks — the real backends are a drop-in the moment the files appear.
- Both real backends spawn `llama-server` on a random **loopback** port and talk to it over HTTP
  (`/v1/chat/completions` streaming for chat, `/v1/embeddings` for the embedder). The processes are
  killed on `stop()` and on `will-quit` (no orphaned `llama-server`).

## Acquiring the binaries / weights — scripted (Phase 12) or manual (R5)
The live path needs artifacts **not in the repo**:
- a `llama.cpp` `llama-server` build for your OS (under `runtime/llama.cpp/<os>/`), and
- the GGUF weights named by the manifests (under `models/...`).

**Phase 12 automates this** with the `fetch-*` scripts (below) — `prepare-drive --with-assets`
downloads + SHA-256-verifies both in one command. You can still drop them in by hand. With either,
start a chat model on the AI Model screen to get real on-device inference and real tokens/sec.

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
  `yaml` / `@noble/hashes`), so the `require()`s in the parsers, manifest loader, and the vault KDF
  resolve at runtime. `electron-builder.yml` sets `includeSubNodeModules: true` (so hoisted/nested
  trees — e.g. mammoth's transitive deps — are collected) and `npmRebuild: false` (no native addons).
  **These are externalized, so a missing one only fails at RUNTIME, not in the green gate — after
  packaging, smoke-test importing a PDF, a DOCX, and a CSV, AND creating/unlocking an encrypted
  workspace (exercises `@noble/hashes` argon2id), from the produced `.exe`.**
- **`tesseract.js` + `tesseract.js-core` are `asarUnpack`ed** (Phase 38): the OCR engine spawns
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

## Preparing a drive — scripts (Phase 11)

`scripts/` provisions and verifies a drive. The scripts are **self-contained** (a drive can be laid
out on a fresh machine with no Node/npm); their layout + config shapes mirror the unit-tested
`apps/desktop/src/main/services/drive.ts` (the canonical reference — keep them in sync).

| Script | Purpose |
|---|---|
| `prepare-drive.{ps1,sh}` | Create the directory tree, copy manifests + user docs, generate `config/{drive,policy}.json`. `-DryRun`/`--dry-run` prints the plan. `-Dev`/`--dev` → a plaintext developer drive. **`-WithAssets`/`--with-assets`** (Phase 12) then runs `fetch-models` + `fetch-runtime` (forwarding `-AcceptLicense`/`--accept-license`) for a launch-ready drive. |
| `fetch-models.{ps1,sh}` | (Phase 12) Download + **resume** + **SHA-256-verify** each weight with a `download:` block to its `models/...` path. `-Only <id>`/`--only` for one model; `-AcceptLicense`/`--accept-license` for the license gate; `-DryRun`/`--dry-run`. Real-hash mismatch → delete partial + exit 1. Idempotent (present + verified → skip). |
| `fetch-runtime.{ps1,sh}` | (Phase 12; GPU defaults Phase 14) Read `runtime-sources.yaml`, pick the host build (`-Os/-Arch/-Backend` overrides; **default = the first listed build: Vulkan on win/linux, Metal on mac**; `-Backend cpu` fetches the pure-CPU safety net into `runtime/llama.cpp/<os>/cpu/`), download + verify the archive, extract into the build's `extract_to` (`chmod +x` on mac/linux), and write a `.hilbertraum-runtime.json` install marker. Idempotent **via the marker** (version + backend must match — a missing/stale marker re-fetches, so a CPU-era drive actually upgrades); `-DryRun`/`--dry-run`. `-Family`/`--family` selects the asset family: `llama_cpp` (default), `whisper_cpp` (the transcriber CLI), or `ocr` (language files). |
| `verify-models.{ps1,sh}` | SHA-256 each present weight vs its manifest hash (placeholder → *UNVERIFIED*; real mismatch → fail/exit 1). `-Generate`/`--generate` writes `config/checksums.json`. |
| `setup-dev.{ps1,sh}` | Dev bootstrap: `NODE_OPTIONS=--use-system-ca npm install` (R6) + build + test smoke. |

The asset-planning + verify logic is mirrored from the unit-tested
`apps/desktop/src/main/services/assets.ts` (the canonical reference — keep in sync), exactly as
`prepare-drive` mirrors `drive.ts`. The scripts use the **OS-native downloader** (`curl` /
`Invoke-WebRequest`, preferring `aria2c` if installed) — no new npm/script deps.

End-to-end (Windows example — one command provisions everything):
```powershell
.\scripts\prepare-drive.ps1 -Target E:\ -WithAssets -AcceptLicense   # layout + download + verify
.\scripts\verify-models.ps1 -Target E:\ -Generate                    # record real hashes
npm run package:win                                                  # build the portable .exe
copy .\apps\desktop\release\*.exe E:\                                 # place the launcher on the drive
```

> ✅ **`runtime-sources.yaml` is pinned to a real release** (`ggml-org/llama.cpp` **b9585**, real
> per-OS URLs + SHA-256 checksums computed from the actual assets) — `fetch-runtime` downloads,
> verifies, extracts (zip and tar.gz) and flattens the binaries for all three OSes from any host.
> Since **Phase 14** the win/linux default is the **Vulkan full build** (GPU acceleration with
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
> 100% offline by default; the in-app downloader (shipped as Phase 18 — architecture.md "In-app model downloader") is
> triple-gated: policy ∧ default-off setting ∧ per-download confirmation, and hidden entirely on
> commercial drives. This does not weaken the offline guarantee.

These artifacts (weights, sidecar binaries, the workspace DB, logs, the portable `.exe`) are all
**git-ignored** — they live on the drive, never in the repo.

## Plug-and-play commercial drive (Phase 13)

A non-technical buyer must be able to **plug in, double-click one icon, and chat** — no Docker, no
installer, no terminal. The chosen mechanism is the **portable bundled app + a tiny native
launcher** — the Phase-12/13 distribution decision (folded in here from the retired
provisioning design record; full original via `git show 4549934:docs/provisioning-and-distribution-plan.md`):

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
prepare-drive  --force            # commercial policy (encrypted, plaintext off, network denied)
fetch-models   --accept-license   # verified weights (a SOLD drive needs an approved, redistributable license — spec §13)
fetch-runtime                     # verified llama.cpp sidecar builds: per OS the default (Vulkan/Metal)
                                  # + the pure-CPU safety net on win/linux (Phase 14)
package + sign + notarize         # MANUAL — secrets never in the repo (pass --app-artifact / --skip-package)
copy launcher + portable app + user docs -> drive root
verify-models  --generate         # capture real hashes -> config/checksums.json
final check: commercial posture (encrypted, network denied) + all weights VERIFIED
             + runtime install markers match the pin (Phase 14) + no user data
```

```powershell
# Windows (supply a pre-built, signed .exe; or --skip-package to assemble + sign yourself)
.\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -AppArtifact .\apps\desktop\release\HilbertRaum-0.1.0-portable.exe
.\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -DryRun        # print the plan
```
```bash
# macOS / Linux
scripts/build-commercial-drive.sh --target /Volumes/HILBERTRAUM --accept-license --app-artifact ./apps/desktop/release/Private\ AI\ Drive\ Lite.app
```

The final automated check asserts the **commercial posture** (`policy.json`: encryption required,
plaintext off, models must verify, network denied) **and** that **every weight is VERIFIED** **and**
that **no user data is present** (spec §12.2) — the canonical gate is `assertCommercialDrive(...)`; the
scripts add a native cross-check of the same invariants. **Remaining manual acceptance (R5/R7):** a
real signed build + notarization + a USB-drive §17 demo on a fresh laptop with Wi-Fi off, and the
second-laptop continuity check.

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

### The `HILBERTRAUM_*` manual harness matrix — a REQUIRED pre-release gate (audit M-A5)

The riskiest integration surface — real `spawn`, the llama-server SSE stream, GPU
`--list-devices` parsing, whisper-cli, WASM OCR, real weights, real retrieval quality —
is **deliberately not in CI** (the zero-binary / zero-network green-gate posture, audit
M-A5). It is covered instead by the `tests/manual/*.test.ts` harnesses, each gated behind
a `HILBERTRAUM_*` env var that points at a provisioned drive / binary / model. They are skipped
unless that env var is set, so a green CI run says nothing about them.

**Before any drive ships, run the applicable subset against the real artifacts** (the dev
box has `F:\paid-gpu-smoke-drive` with the b9585 binary + Qwen3-4B; see BUILD_STATE).
Treat this as part of the gate, not optional polish:

| Harness | Env var(s) | Proves |
| --- | --- | --- |
| `bringup-smoke` | `HILBERTRAUM_BRINGUP_SMOKE` | the runtime starts + streams against the real binary |
| `gpu-smoke` | `HILBERTRAUM_GPU_SMOKE` | rung-1 GPU start, forced-CPU rung, rung-3 safety net |
| `thinking-smoke` / `gemma-thinking` | `HILBERTRAUM_THINKING_SMOKE` / `HILBERTRAUM_GEMMA_THINKING` | deep-mode reasoning channel |
| `rerank-smoke` | `HILBERTRAUM_RERANK_SMOKE` | the reranker sidecar reorders retrieval |
| `whisper-smoke` / `dictation-smoke` | `HILBERTRAUM_WHISPER_SMOKE` / `HILBERTRAUM_DICTATION_SMOKE` | whisper-cli transcription + dictation |
| `ocr-smoke` | `HILBERTRAUM_OCR_SMOKE` | WASM OCR over a real scan |
| `compare-smoke` / `translation-smoke` | `HILBERTRAUM_COMPARE_SMOKE` / `HILBERTRAUM_TRANSLATION_SMOKE` | the doc-task pipelines end-to-end |
| `rag-quality` / `minsim-measure` | `HILBERTRAUM_RAG_QUALITY` / `HILBERTRAUM_MINSIM_MEASURE` | retrieval quality + the similarity floor |
| `server-concurrency-probe` | `HILBERTRAUM_CONCURRENCY_PROBE` | the one-at-a-time sidecar invariant |
| `model-eval` | `HILBERTRAUM_MODEL_EVAL` | the model-recommendation ladder on real hardware |

**Canned-real-output regression-fixture policy:** because these never run in CI, an
upstream format change (SSE shape, `--list-devices` lines, whisper JSON) would otherwise
slip past the green gate and only surface on real hardware. So **whenever a `HILBERTRAUM_*` run
observes an upstream output format change — or a new format worth pinning — capture the
verbatim real output into `apps/desktop/tests/fixtures/` and assert a pure parser against
it in a CI unit test** (the bytes are kept binary via `.gitattributes`). The first such
fixture is the b9585 `--list-devices` capture parsed by `gpu.test.ts` (audit L19); add SSE
and whisper-JSON fixtures the same way as those formats are observed.
