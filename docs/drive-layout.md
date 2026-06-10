# Drive & Workspace Layout

_Last updated: 2026-06-10 (Phase 14: Vulkan-default runtime + `<os>/cpu/` safety net + `.paid-runtime.json` markers)_

## How the app finds its data

At startup (`main/index.ts` → `initBackend()`), the app resolves a **root path** using
`services/workspace.ts` → `resolvePaths()`, in this priority:

1. **`PAID_DRIVE_ROOT` environment variable** — explicit override (used when launching from a
   prepared drive, or for testing). If the root contains `config/drive.json`, it is treated as a
   **prepared drive**.
2. **App-data fallback** — `app.getPath('userData')` for a normal install / dev run.

From the root, these paths are derived and created (idempotently) on first run:

```
<root>/
├── workspace/
│   ├── paid.sqlite        # all app data (spec §8 tables) — paid.sqlite.enc at rest in
│   │                      # encrypted mode (decrypted to paid.sqlite only while unlocked)
│   └── documents/         # stored copies of imported files (<id><ext>.enc in encrypted mode)
├── models/                # GGUF weights (git-ignored, never committed)
├── logs/
│   └── app.log            # local rotating logs (never uploaded; not encrypted)
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
├── Start Private AI Drive.cmd                  # Windows launcher (Phase 13) ── DOUBLE-CLICK THIS
├── Start Private AI Drive.command              # macOS launcher (Phase 13)
├── start-private-ai-drive.sh                   # Linux launcher (Phase 13)
├── READ ME FIRST.txt                           # friendly first-run + SmartScreen note (Phase 13)
├── PrivateAIDriveLite-<version>-portable.exe   # the portable build (Phase 11) — signed for commercial
├── runtime/llama.cpp/{win,mac,linux}/          # default sidecar build (Phase 10; Vulkan on win/linux since Phase 14)
│   ├── .paid-runtime.json                       # install marker: { version, backend, os, arch } (Phase 14)
│   └── cpu/                                     # pure-CPU safety-net build + its own marker (win/linux only, Phase 14)
├── models/{chat,embeddings,reranker}/          # GGUF weights (git-ignored; reranker/ is an optional Phase-21 quality add-on)
├── model-manifests/{chat,embeddings,reranker}/ # committed YAML (the only model metadata in git)
│   └── runtime-sources.yaml                     # sidecar download manifest (Phase 12)
├── workspace/                                  # paid.sqlite (encrypted or plaintext) — EMPTY on a sold drive
├── logs/
├── docs/                                       # user guide, privacy, troubleshooting
└── config/{drive.json,policy.json,checksums.json}
```

> **Launchers (Phase 13).** The `Start Private AI Drive.*` files sit at the drive root beside the
> portable app and set `PAID_DRIVE_ROOT` from **their own location** every launch — never a hardcoded
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
>   `paid.sqlite` or `paid.sqlite.enc` (mode is an attribute, not a directory), and the embeddings
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
exit 1; placeholder hash → *UNVERIFIED*). You can still drop artifacts in by hand (R5). `verify-models`
SHA-256s each present weight against its manifest hash, and `--generate` captures real hashes into
`config/checksums.json`. The asset logic mirrors the unit-tested `services/assets.ts`; the sidecar
build comes from `model-manifests/runtime-sources.yaml`. See
[`packaging.md`](packaging.md) + [`model-policy.md`](model-policy.md) for the full flow + license gate.

### Sidecar builds: Vulkan default + CPU safety net (Phase 14)

Since Phase 14 (see [`gpu-support-plan.md`](gpu-support-plan.md)) `runtime-sources.yaml` is
**vulkan-first** on Windows/Linux:

- **`runtime/llama.cpp/<os>/`** holds the **Vulkan full build** — it ships every CPU backend
  variant alongside the Vulkan one (dynamic backend loading), so on a machine with no usable GPU
  it *is* the CPU build. This is the binary `services/runtime/sidecar.ts` resolves, unchanged.
- **`runtime/llama.cpp/<os>/cpu/`** (win/linux only) holds the **pure-CPU safety net** — used only
  if the default binary itself cannot start (the app's fallback ladder rung 3). Fetch it with
  `fetch-runtime --backend cpu`.
- **mac is unchanged**: the arm64 Metal build, no `cpu/` subdir.
- Each extraction dir carries a **`.paid-runtime.json` install marker**
  (`{ version, backend, os, arch }`), written by `fetch-runtime` after a verified extraction.
  Re-runs skip only when the marker matches the pinned version + backend — so bumping the pin or
  switching a CPU-era drive to the Vulkan default actually re-fetches (mere binary presence is not
  trusted). Canonical logic: `services/assets.ts` (`runtimeInstallCurrent`, `readRuntimeMarker`).

Existing DIY drives keep working untouched: their flat `<os>/` dir holds a CPU build that resolves
exactly as before (it just re-fetches as the Vulkan default on the next `fetch-runtime` run).

## Portability notes
- No hardcoded absolute paths; everything derives from the resolved root (spec rule).
- Path separators handled via `node:path`; works on Windows/macOS/Linux.
- The SQLite file is self-contained, so moving the `workspace/` folder moves all data.
