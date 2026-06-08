# Drive & Workspace Layout

_Last updated: 2026-06-09 (Phase 1)_

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
├── Start Private AI Drive.exe / .app / .sh
├── app/{windows,macos,linux}/
├── runtime/llama.cpp/{windows,macos,linux}/   # sidecars (Phase 10)
├── models/{chat,embeddings,manifests}/
├── workspace/{encrypted,plaintext-dev,backups}/
├── updates/{incoming,applied}/
├── logs/
├── docs/                                       # user guide, privacy, troubleshooting
└── config/{drive.json,policy.json,checksums.json}
```

The `prepare-drive` scripts that generate this layout land in **Phase 11**.

## Portability notes
- No hardcoded absolute paths; everything derives from the resolved root (spec rule).
- Path separators handled via `node:path`; works on Windows/macOS/Linux.
- The SQLite file is self-contained, so moving the `workspace/` folder moves all data.
