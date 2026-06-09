# Drive & Workspace Layout

_Last updated: 2026-06-09 (Phase 11)_

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
│   └── paid.sqlite        # all app data (spec §8 tables)
├── models/                # GGUF weights (git-ignored, never committed)
├── logs/
│   └── app.log            # local rotating logs (never uploaded)
└── config/                # drive.json / policy.json / checksums.json (Phase 8/11)
```

`buildDriveStatus()` reports root/workspace/models/logs paths, prepared-drive flag, writability,
free space, and OS/arch — surfaced on the **Diagnostics** screen.

## Prepared external drive (commercial layout, spec §6)

A prepared drive uses the fuller layout below. The app detects it via the `config/drive.json`
marker and uses the drive's `models/` and `workspace/` directly, so the same workspace moves between
laptops (spec success criterion #10).

```
PRIVATE_AI_DRIVE/
├── PrivateAIDriveLite-<version>-portable.exe   # the portable build (Phase 11)
├── runtime/llama.cpp/{win,mac,linux}/          # sidecars (Phase 10)
├── models/{chat,embeddings}/                   # GGUF weights (git-ignored)
├── model-manifests/{chat,embeddings}/          # committed YAML (the only model metadata in git)
├── workspace/                                  # paid.sqlite (encrypted or plaintext)
├── logs/
├── docs/                                       # user guide, privacy, troubleshooting
└── config/{drive.json,policy.json,checksums.json}
```

> **Naming reconciliation (Phase 11).** This layout reflects what the **code actually reads**,
> which is the source of truth:
> - Sidecar OS sub-dirs are **`win` / `mac` / `linux`** (resolved by `services/runtime/sidecar.ts`
>   `llamaOsDir`), **not** the spec's prose `windows/macos/linux`.
> - Model manifests live in a **top-level `model-manifests/`** dir (discovered by
>   `services/models.ts` `resolveManifestsDir`), **not** `models/manifests/`.
>
> The `apps/desktop/src/main/services/drive.ts` module (`DRIVE_LAYOUT_DIRS`) is the canonical,
> unit-tested list of these directories; the `prepare-drive` scripts create exactly that set.

## Preparing a drive (Phase 11 scripts)

The `scripts/` directory lays out and verifies a drive. The scripts are **self-contained**
(no Node/npm needed to prepare a drive); their logic mirrors the unit-tested
`services/drive.ts`. See [`packaging.md`](packaging.md) for the full flow.

```powershell
# Windows
.\scripts\prepare-drive.ps1 -Target E:\ -DryRun   # print the plan, create nothing
.\scripts\prepare-drive.ps1 -Target E:\           # create dirs + manifests + config
.\scripts\verify-models.ps1  -Target E:\          # checksum the weights
.\scripts\verify-models.ps1  -Target E:\ -Generate  # write config/checksums.json
```
```bash
# macOS / Linux
scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE --dry-run
scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE
scripts/verify-models.sh  --target /Volumes/PRIVATE_AI_DRIVE
scripts/verify-models.sh  --target /Volumes/PRIVATE_AI_DRIVE --generate
```

`prepare-drive` creates the directory tree, copies the committed manifests + user docs onto the
drive, and generates `config/drive.json` (the prepared-drive marker) + `config/policy.json`
(deny-by-default offline posture; `--dev`/`-Dev` for a plaintext developer drive). It **never**
downloads weights or sidecar binaries — those are git-ignored and dropped in manually (R5).
`verify-models` SHA-256s each present weight against its manifest hash (placeholder hashes report
*UNVERIFIED*, not a pass/fail), and `--generate` captures real hashes into `config/checksums.json`.

## Portability notes
- No hardcoded absolute paths; everything derives from the resolved root (spec rule).
- Path separators handled via `node:path`; works on Windows/macOS/Linux.
- The SQLite file is self-contained, so moving the `workspace/` folder moves all data.
