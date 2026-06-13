# Drive & Workspace Layout

_Last updated: 2026-06-11 (Phase 38: the `ocr/` language-file asset class)_

## How the app finds its data

At startup (`main/index.ts` → `initBackend()`), the app resolves a **root path** using
`services/workspace.ts` → `resolvePaths()`, in this priority:

1. **`HILBERTRAUM_DRIVE_ROOT` environment variable** — explicit override (used when launching from a
   prepared drive, or for testing). If the root contains `config/drive.json`, it is treated as a
   **prepared drive**.
2. **App-data fallback** — `app.getPath('userData')` for a normal install / dev run.

From the root, these paths are derived and created (idempotently) on first run:

```
<root>/
├── workspace/
│   ├── hilbertraum.sqlite        # all app data (spec §8 tables) — hilbertraum.sqlite.enc at rest in
│   │                      # encrypted mode (decrypted to hilbertraum.sqlite only while unlocked)
│   └── documents/         # stored copies of imported files (<id><ext>.enc in encrypted mode)
├── models/                # GGUF weights (git-ignored, never committed)
├── logs/
│   └── app.log[.enc]      # local rotating logs (never uploaded; .enc on an encrypted workspace)
└── config/                # drive.json / policy.json / checksums.json / workspace.json (vault descriptor)
```

`buildDriveStatus()` reports root/workspace/models/logs paths, prepared-drive flag, writability,
free space, and OS/arch — surfaced on the **Diagnostics** screen.

## Prepared external drive (commercial layout, spec §6)

A prepared drive uses the fuller layout below. The app detects it via the `config/drive.json`
marker and uses the drive's `models/` and `workspace/` directly, so the same workspace moves between
laptops (spec success criterion #10).

```
PRIVATE_AI_DRIVE/
├── Start HilbertRaum.cmd                  # Windows launcher (Phase 13) ── DOUBLE-CLICK THIS
├── Start HilbertRaum.command              # macOS launcher (Phase 13)
├── start-hilbertraum.sh                   # Linux launcher (Phase 13)
├── READ ME FIRST.txt                           # friendly first-run + SmartScreen note (Phase 13)
├── HilbertRaum-<version>-portable.exe   # the portable build (Phase 11) — signed for commercial
├── runtime/llama.cpp/{win,mac,linux}/          # default sidecar build (Phase 10; Vulkan on win/linux since Phase 14)
│   ├── .hilbertraum-runtime.json                       # install marker: { version, backend, os, arch } (Phase 14)
│   └── cpu/                                     # pure-CPU safety-net build + its own marker (win/linux only, Phase 14)
├── runtime/whisper.cpp/{win,mac,linux}/        # SECOND sidecar family (Phase 36): the whisper-cli transcriber
│   └── .hilbertraum-runtime.json                       # same marker scheme; win = upstream prebuilt, mac/linux = source-build (see below)
├── models/{chat,embeddings,reranker,transcriber}/ # weights (git-ignored; transcriber/ holds the whisper GGML .bin)
├── ocr/                                        # OCR language files (Phase 38): {deu,eng}.traineddata.gz — plain sha256-verified, git-ignored
├── model-manifests/{chat,embeddings,reranker,transcriber}/ # committed YAML (the only model metadata in git)
│   └── runtime-sources.yaml                     # sidecar download manifest (Phase 12; + whisper_cpp block Phase 36; + ocr block Phase 38)
├── workspace/                                  # hilbertraum.sqlite (encrypted or plaintext) — EMPTY on a sold drive
├── logs/
├── docs/                                       # user guide, privacy, troubleshooting
└── config/{drive.json,policy.json,checksums.json}
```

> **Launchers (Phase 13).** The `Start HilbertRaum.*` files sit at the drive root beside the
> portable app and set `HILBERTRAUM_DRIVE_ROOT` from **their own location** every launch — never a hardcoded
> drive letter — so the same drive continues the same encrypted workspace on any laptop (success
> criterion #10). The canonical resolver is `services/launcher.ts` `resolveDriveRootFromLauncher`.
> A **commercial (sellable) drive** ships `policy.json` in the commercial posture (encryption required,
> plaintext off, models must verify, network denied) and contains **no user data** — built + asserted
> by `scripts/build-commercial-drive.{ps1,sh}` (canonical: `services/commercial-drive.ts`). See
> [`packaging.md`](packaging.md).

> **Naming reconciliation (Phase 11).** This layout reflects what the **code actually reads**,
> which is the source of truth:
> - Sidecar OS sub-dirs are **`win` / `mac` / `linux`** (resolved by `services/runtime/sidecar.ts`
>   `llamaOsDir`), **not** the spec's prose `windows/macos/linux`.
> - Model manifests live in a **top-level `model-manifests/`** dir (discovered by
>   `services/models.ts` `resolveManifestsDir`), **not** `models/manifests/`.
> - The spec §6 sketch also shows `updates/{incoming,applied}/`, `workspace/{encrypted,
>   plaintext-dev,backups}/`, and `runtime/embeddings/` — **not shipped**: there is no update
>   mechanism yet (see *Updating a drive* below), the workspace is a single flat dir whose DB is
>   `hilbertraum.sqlite` or `hilbertraum.sqlite.enc` (mode is an attribute, not a directory), and the embeddings
>   sidecar reuses the same `runtime/llama.cpp/<os>/` binary.
>
> The `apps/desktop/src/main/services/drive.ts` module (`DRIVE_LAYOUT_DIRS`) is the canonical,
> unit-tested list of these directories; the `prepare-drive` scripts create exactly that set.

## Updating a drive (manual — spec §12.3)

There is **no in-app updater** (by design: the app makes no network calls). Updating a prepared
drive is the same flow as building it, run again from a machine with the repo:

1. `prepare-drive --target <drive> --force` refreshes `model-manifests/` + the bundled docs +
   `config/{drive,policy}.json` (the workspace and weights are untouched).
2. `fetch-models` / `fetch-runtime` download anything new (present + verified files are skipped).
3. Replace the portable app/launchers at the drive root with the new build.
4. `verify-models --target <drive> --strict` confirms every weight still verifies.

The user's `workspace/` (and its encrypted data) is never modified by an update.

## Preparing a drive (Phase 11 scripts)

The `scripts/` directory lays out and verifies a drive. The scripts are **self-contained**
(no Node/npm needed to prepare a drive); their logic mirrors the unit-tested
`services/drive.ts`. See [`packaging.md`](packaging.md) for the full flow.

```powershell
# Windows
.\scripts\prepare-drive.ps1 -Target E:\ -DryRun                 # print the plan, create nothing
.\scripts\prepare-drive.ps1 -Target E:\                         # create dirs + manifests + config
.\scripts\prepare-drive.ps1 -Target E:\ -WithAssets -AcceptLicense  # + download & verify assets (Phase 12)
.\scripts\verify-models.ps1  -Target E:\ -Generate              # checksum + write config/checksums.json
```
```bash
# macOS / Linux
scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE --dry-run
scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE
scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE --with-assets --accept-license
scripts/verify-models.sh  --target /Volumes/PRIVATE_AI_DRIVE --generate
```

`prepare-drive` creates the directory tree, copies the committed manifests + user docs onto the
drive, and generates `config/drive.json` (the prepared-drive marker) + `config/policy.json`
(deny-by-default offline posture; `--dev`/`-Dev` for a plaintext developer drive).

By default it does **not** download artifacts. **Phase 12** adds `--with-assets`/`-WithAssets`, which
then runs `fetch-models` (weights) + `fetch-runtime` (the `llama-server` sidecar) — each download is
**resumable** and **SHA-256-verified before it counts as installed** (mismatch → delete partial +
exit 1; placeholder hash → *UNVERIFIED*). For a fast setup `--with-assets` fetches **only the default
chat model** (Ministral 3 8B); the user pulls any other models from the app's AI Model screen on
demand. Add `--all-models`/`-AllModels` to provision every model up front. You can still drop artifacts in by hand (R5). `verify-models`
SHA-256s each present weight against its manifest hash, and `--generate` captures real hashes into
`config/checksums.json`. The asset logic mirrors the unit-tested `services/assets.ts`; the sidecar
build comes from `model-manifests/runtime-sources.yaml`. See
[`packaging.md`](packaging.md) + [`model-policy.md`](model-policy.md) for the full flow + license gate.

### Sidecar builds: Vulkan default + CPU safety net (Phase 14)

Since Phase 14 (see the [`architecture.md`](architecture.md) GPU record §6) `runtime-sources.yaml` is
**vulkan-first** on Windows/Linux:

- **`runtime/llama.cpp/<os>/`** holds the **Vulkan full build** — it ships every CPU backend
  variant alongside the Vulkan one (dynamic backend loading), so on a machine with no usable GPU
  it *is* the CPU build. This is the binary `services/runtime/sidecar.ts` resolves, unchanged.
- **`runtime/llama.cpp/<os>/cpu/`** (win/linux only) holds the **pure-CPU safety net** — used only
  if the default binary itself cannot start (the app's fallback ladder rung 3). Fetch it with
  `fetch-runtime --backend cpu`.
- **mac is unchanged**: the arm64 Metal build, no `cpu/` subdir.
- Each extraction dir carries a **`.hilbertraum-runtime.json` install marker**
  (`{ version, backend, os, arch }`), written by `fetch-runtime` after a verified extraction.
  Re-runs skip only when the marker matches the pinned version + backend — so bumping the pin or
  switching a CPU-era drive to the Vulkan default actually re-fetches (mere binary presence is not
  trusted). Canonical logic: `services/assets.ts` (`runtimeInstallCurrent`, `readRuntimeMarker`).

Existing DIY drives keep working untouched: their flat `<os>/` dir holds a CPU build that resolves
exactly as before (it just re-fetches as the Vulkan default on the next `fetch-runtime` run).

### Second sidecar family: the whisper.cpp transcriber (Phase 36)

Audio transcription uses a separate, pinned **whisper.cpp** CLI under
`runtime/whisper.cpp/<os>/` (resolved by `services/transcriber/cli.ts`
`resolveWhisperCliPath`; `HILBERTRAUM_WHISPER_BIN` overrides for dev). It rides the SAME
distribution machinery as the llama family:

- The pin lives in `runtime-sources.yaml` under the additive **`whisper_cpp:`** block
  (same `{ version, builds[] }` shape, own tag — currently `v1.8.6`). A pre-Phase-36
  app ignores the block entirely (verified forward-compatibility).
- Fetch with **`fetch-runtime --family whisper_cpp`** (`-Family whisper_cpp` on
  PowerShell) — same verify-before-trust + `.hilbertraum-runtime.json` marker idempotency.
- **CPU-only by design** (the E5/reranker precedent: transcription is a batch job).
- **Upstream ships prebuilt binaries for WINDOWS ONLY** (R-W1, 2026-06-11). The
  mac/linux dirs exist in the layout, but provisioning them means compiling the pinned
  tag from source (`cmake -B build && cmake --build build -j --config Release`, then
  copy `build/bin/whisper-cli` + libs into `runtime/whisper.cpp/<os>/` and write the
  marker). A drive without a whisper binary still works fully — audio imports fail
  per-file with friendly copy pointing at the AI Model screen.
- Weights are a NORMAL model manifest (`model-manifests/transcriber/`,
  `role: transcriber`) → `fetch-models` and the Phase-18 in-app downloader cover them
  with zero new code; they land in `models/transcriber/`.

### OCR language files (Phase 38)

Local OCR ("Make searchable (OCR)" for scanned PDFs; photo imports) uses
**tesseract.js**, which ships INSIDE the app as pinned npm dependencies — the drive
carries ONLY the language data under `ocr/`:

- The pin lives in `runtime-sources.yaml` under the additive **`ocr:`** block — a NEW
  asset class (D32): plain files `{ lang, url, sha256, dest }`, no extraction, no
  install marker. Idempotency IS the hash: present + matching sha256 ⇒ skip.
- Fetch with **`fetch-runtime --family ocr`** (`-Family ocr` on PowerShell) — one run
  covers every OS (the data is platform-independent).
- Shipped files: `deu.traineddata.gz` (1.27 MB) + `eng.traineddata.gz` (2.82 MB), the
  tessdata_best-integerized variant (R-O3), exactly as tesseract.js reads them
  (`langPath` + gzip — never decompressed on the drive).
- A drive WITHOUT the `ocr/` files still works fully: detected scans show the friendly
  notice without the OCR offer, and photo imports fail per-file with friendly copy.
  `assertCommercialDrive` + both build-commercial-drive script gates verify the files
  on a SOLD drive.

## Portability notes
- No hardcoded absolute paths; everything derives from the resolved root (spec rule).
- Path separators handled via `node:path`; works on Windows/macOS/Linux.
- The SQLite file is self-contained, so moving the `workspace/` folder moves all data.
