# Phase 11 kickoff prompt — drive layout, prepare-drive scripts & packaging

> Paste this as the kickoff prompt for the next session. It mirrors the Phase 8/9/10 handoff style.

---

You are continuing work on the **Private AI Drive Lite** project (an open-source, offline,
local-LLM desktop app) located at `f:\_coding\ai_drive`.

## START BY READING, IN THIS ORDER

1. **`BUILD_STATE.md`** — the live handoff/state file (current status, decisions, data
   contracts, next actions, risks). Source of truth for where we are. Read **§5 (START OF
   PHASE 11)** carefully, plus these contract sections: **Workspace/paths** (`resolvePaths`,
   `PAID_DRIVE_ROOT`, `config/drive.json` marker, `isPreparedDrive`), **Models + runtime
   (Phase 2 live)** (`resolveManifestsDir`/`PAID_MANIFESTS_DIR`, `sha256File`, `verifyChecksum`,
   `computeInstallState`, the `REPLACE_WITH_REAL_HASH` placeholder gate), **Privacy & offline
   policy (Phase 8 live)** (`loadPolicy` reads optional `config/policy.json` + `config/drive.json`;
   deny-by-default), the **Encrypted workspace (Phase 9 live)** section, and the **Real runtime +
   embedder (Phase 10 live)** section (the sidecar discovery contract: `resolveLlamaServerPath` →
   `runtime/llama.cpp/<os>/llama-server[.exe]`, `PAID_LLAMA_BIN` override, the **localhost-only**
   binding, the **graceful-fallback rule**). In the **Decisions log** note the `node:sqlite`/
   Electron-37 pin, the **mock-first** decision, the **loopback-exception (LOCKED, Phase 8)**, the
   **localhost-only binding (LOCKED, Phase 10)**, and the **graceful-fallback rule (LOCKED,
   Phase 10)**.
2. **`docs/IMPLEMENTATION_PLAN.md`** — read the **Phase 11** section (deliverables:
   `scripts/prepare-drive.ps1` + `.sh`, `verify-models.ps1` + `.sh`, `setup-dev.ps1` + `.sh`, drive
   `config/{drive,policy,checksums}.json` generators per spec §6, `electron-builder` packaging config
   for a **portable Windows build runnable from an external drive**, user-guide/troubleshooting docs),
   the **§4b critique** (the **"honesty about scope"** paragraph: Phase 11, like Phase 10, has
   **manual, hardware-dependent acceptance** — packaging from a real USB drive + a live end-to-end
   demo need artifacts and hardware not in the repo), AND the **"Per-phase ritual"** (§3).
3. **`CLAUDE.md`** — the hard rules (no cloud, no telemetry, **no hosted AI APIs**, keep the app
   fully usable **with no internet**, **no hardcoded developer-specific absolute paths / don't assume
   the drive path is identical across OSes**, **Windows first-class, keep macOS/Linux supported in the
   architecture**, never commit model weights/user data/logs/generated files). Phase 11 is packaging +
   scripts — it must keep the app 100% offline at runtime (install-time network for the Electron binary
   is dev-only, R2) and must not weaken any privacy guarantee.
4. **`docs/packaging.md`** (Phase 10 — extend it) + **`docs/drive-layout.md`** (Phase 1 — extend +
   reconcile). These describe the drive layout (`runtime/llama.cpp/<os>/`, `models/...`,
   `model-manifests/`, `workspace/`, `config/`, `logs/`) and that the binaries + weights are
   git-ignored. ⚠️ **Reconcile a naming discrepancy:** `drive-layout.md` documents the sidecar dirs as
   `runtime/llama.cpp/{windows,macos,linux}/` and models as `models/{chat,embeddings,manifests}/`, but
   the **Phase-10 code** (`services/runtime/sidecar.ts` `llamaOsDir`) actually resolves
   `runtime/llama.cpp/{win,mac,linux}/`, and manifests live in a top-level **`model-manifests/`** dir
   (not `models/manifests/`). The prepare-drive scripts MUST lay out the directories the code actually
   reads (`win`/`mac`/`linux`); fix the docs to match (or, if you change the code's os-dir keys, change
   both — but the code is the source of truth and is already tested).
5. **`CLAUDE_Private_AI_Drive_Lite_MVP.md`** — the source of truth for *what* to build:
   - **§6 (Drive layout)** — the full prepared-drive directory tree + the
     `config/{drive,policy,checksums}.json` files the scripts generate.
   - **§12 (Packaging / distribution)** — the portable build that launches from an external drive.
   - **§17 (Non-technical demo)** — the end-to-end story a non-technical user can complete; Phase 11
     must make this path real (or documented + scripted).
   - **Milestone 10 (real criteria)**: prepare-drive works, the app launches from the drive, models are
     verified, a user guide is included, and the §17 non-technical demo is completable.
   - **§15 (tests)**: prepare-drive **dry-run** creates the layout; checksum generation/verification.

## CONTEXT: Phases 0–10 are complete and committed (latest commit `01a1694` "Phase 10 / Milestone 2 (real): real llama.cpp runtime & real embeddings")

- **Phase 10** delivered the real `LlamaRuntime` (loopback `llama-server` sidecar, OpenAI-compatible
  streaming) + the real `E5Embedder` (loopback `llama-server --embedding`), both **behind the existing
  interfaces** and **opt-in by availability** (a selecting runtime factory + a selecting embedder
  factory return the real backend only when the sidecar binary **and** the GGUF weights are present,
  else the mock). Sidecar discovery resolves `runtime/llama.cpp/<os>/llama-server[.exe]` (with a
  `PAID_LLAMA_BIN` env override). **R5 remains:** the platform `llama-server` binaries + GGUF weights
  are **not** in the repo, so a live model answer is manual — Phase 11's prepare-drive scripts are what
  put those files onto a real drive.
- **All 190 tests pass**; typecheck clean; `NODE_OPTIONS=--use-system-ca npm run build` green (main
  bundle 95.56 kB). **No new dependencies.**
- **Phase 10 also fixed a latent `.gitignore` bug:** the drive-sidecar `runtime/` pattern was
  unanchored and had been silently un-tracking `apps/desktop/src/main/services/runtime/` (the runtime
  service source) — now anchored to `/runtime/`. ⚠️ **Phase 11 will add `models/`, `*.gguf`, `logs/`,
  `workspace/` artifacts onto a drive; keep them git-ignored** and double-check no *source* dir is
  caught by a broad ignore pattern (the `models/`/`workspace/`/`logs/` patterns are still unanchored —
  verify they don't match anything in the source tree before relying on them).

### Things already in place for Phase 11 (do not rebuild)

- **`services/workspace.ts`** — `resolvePaths({ envRoot: PAID_DRIVE_ROOT, fallbackRoot })` →
  `ResolvedPaths` (root/workspace/models/logs/config/dbPath + `isPreparedDrive`). A root is a
  **prepared drive** when it contains `config/drive.json`. `ensureWorkspaceDirs` creates the layout
  idempotently; `buildDriveStatus` reports it. **The scripts generate exactly this layout** — don't
  invent a second path scheme; lay out what `resolvePaths` reads.
- **`services/models.ts`** — `sha256File(path)` (streams large GGUFs), `verifyChecksum(path,
  expected)` → `{ exists, matched, actual }` (a placeholder hash → `matched:null`), `computeInstallState`
  (the `missing`/`checksum_failed`/`installed`/`unsupported` machine, gated by `developerMode` /
  `isRealSha256`), `resolveManifestsDir(startDir, PAID_MANIFESTS_DIR)`, `weightPath(root, manifest)`.
  **`verify-models` should reuse this verification semantics** (hash → compare to manifest `sha256`) so
  the script + the app agree. The manifests currently carry `sha256: REPLACE_WITH_REAL_HASH` — real
  hashes land with real weights.
- **`services/policy.ts`** — `loadPolicy(configDir)` reads optional `config/policy.json` +
  `config/drive.json`, merges over the **deny-by-default** `DEFAULT_POLICY`. **The `config/*.json`
  generators must emit shapes `parsePolicy`/`mergePolicyObject` accept** (snake_case JSON booleans).
  Don't change the policy resolution; generate files it already understands.
- **`services/runtime/sidecar.ts`** — `resolveLlamaServerPath` + `llamaServerDir`/`llamaOsDir`/
  `llamaServerBinaryName` define **where the scripts must place the sidecar binaries**
  (`runtime/llama.cpp/{win,mac,linux}/llama-server[.exe]`). `PAID_LLAMA_BIN` is the dev override.
- **`model-manifests/`** (committed): chat = `qwen3-1.7b/4b/8b-instruct-q4`; embeddings =
  `multilingual-e5-small-q8`. Each manifest has `local_path` (relative to the drive root, e.g.
  `models/embeddings/...gguf`), `sha256`, `download_url` (currently `null`), and
  `bundled_on_preconfigured_drive`. **`prepare-drive` resolves weight destinations from these
  manifests** (`weightPath`), and **`verify-models` checks them against `sha256`**.
- **`electron.vite.config.ts`** already externalizes the parser libs (`pdfjs-dist`/`mammoth`/
  `papaparse`) + `yaml` via `externalizeDepsPlugin` — packaging must keep those `external` deps present
  in the shipped `node_modules` (or bundled appropriately). **`node:sqlite` lives in Electron 37's
  bundled Node** — the packaged app must run on Electron ≥ 37 (Node 22.x), NOT a stripped runtime.
- **Verify commands** unchanged: `npm run typecheck`, `npm test`, `NODE_OPTIONS=--use-system-ca npm
  run build`. **ESLint is NOT installed** — `npm run lint` fails by design and is NOT part of green.
- **No `scripts/` directory and no `electron-builder` dep/config exist yet** — both are net-new in
  Phase 11. `electron-builder` is the only likely new dependency; install it with
  `NODE_OPTIONS=--use-system-ca npm install -D electron-builder` (R6) and record it in BUILD_STATE.

## YOUR TASK: Implement Phase 11 — "Drive layout, prepare-drive scripts & packaging" (spec Milestone 10)

Follow `BUILD_STATE` §5 and the Phase 11 plan section, in order:

1. **`scripts/prepare-drive.ps1` + `scripts/prepare-drive.sh` (new) — lay out a drive.** Given a target
   root (param/arg, e.g. a USB mount point — **never a hardcoded path**), create the spec §6 layout the
   app actually reads: `workspace/`, `models/{chat,embeddings}/`, `model-manifests/` (copied from the
   repo), `runtime/llama.cpp/{win,mac,linux}/`, `logs/`, `config/`. Generate
   `config/{drive,policy,checksums}.json` (see step 4). Idempotent + a **`-DryRun`/`--dry-run`** mode
   that prints the plan + creates nothing destructive (the **dry-run is the automatable test**). Do NOT
   download or commit weights/binaries — the script lays out the tree + tells the user where to drop the
   GGUFs + the `llama-server` binaries (R5: those artifacts are not in the repo).
2. **`scripts/verify-models.ps1` + `.sh` (new) — checksum verification.** Walk the manifests, resolve
   each `local_path` under the drive root (`weightPath` semantics), SHA-256 each present weight, and
   compare to the manifest `sha256` (a `REPLACE_WITH_REAL_HASH` placeholder → report "unverified
   (placeholder hash)", not a hard failure; a real-hash mismatch → fail). Mirror
   `services/models.ts` `verifyChecksum`/`isRealSha256` semantics so the script + app agree. Offer a
   **generate** mode that writes `config/checksums.json` (and can fill manifest hashes) from the present
   weights, so a drive builder can capture real hashes once.
3. **`scripts/setup-dev.ps1` + `.sh` (new) — dev bootstrap.** `NODE_OPTIONS=--use-system-ca npm
   install` (R6), then `npm run build` / `npm test` smoke. Document the TLS-proxy workaround (R6) +
   the Electron-binary download (R2). No surprises; just the documented steps in one script.
4. **`config/{drive,policy,checksums}.json` generators (spec §6).** Emit shapes the existing loaders
   accept: `drive.json` (the prepared-drive **marker** `resolvePaths` keys off + drive metadata),
   `policy.json` (snake_case booleans `parsePolicy`/`mergePolicyObject` read — default to the
   **deny-by-default** offline posture), `checksums.json` (per-weight expected hashes from
   verify-models). Keep them **optional + safe-by-default** (the app already tolerates missing/malformed
   → defaults + warn). These are written onto the **drive**, never committed.
5. **`electron-builder` packaging config — a portable Windows build runnable from an external drive.**
   Add `electron-builder` (dev dep) + config (a `portable` Windows target; macOS/Linux targets defined
   for architecture parity even if only Windows is built here). Ensure `model-manifests/` ship under
   app resources and `PAID_MANIFESTS_DIR` resolves in the packaged app; ensure the packaged runtime is
   **Electron ≥ 37** (so `node:sqlite` exists) and the externalized parser deps are present. The build
   must **launch from a drive** using `PAID_DRIVE_ROOT` (the prepared-drive path). Add an
   `npm run package` (or workspace script). ⚠️ **A real packaged build may need dev-time network for the
   Electron binary (R2)** and is **hardware/OS-dependent** — if it can't be fully run here, wire the
   config + scripts and mark the actual `.exe` production as a **manual** acceptance step (document the
   exact command).
6. **User docs — guide + troubleshooting (spec §17, §18).** A non-technical **user guide** (how to
   plug in the drive, launch, pick a model, chat, ask documents) + a **troubleshooting** doc (no model
   found → it falls back to the mock; slow drive; unlock/password; offline is normal). Make the §17
   non-technical demo path real or clearly documented end-to-end.
7. **Tests** (keep all **190** existing green): prepare-drive **dry-run** produces the expected layout
   (test the underlying **pure layout/■config-generation functions** — factor the script logic into a
   testable TS helper if practical, or test a Node entrypoint the scripts call, so CI doesn't depend on
   PowerShell); checksum **generation + verification** against a fixture weight (a tiny temp file with a
   known SHA-256 + a manifest stub) exercising both the placeholder-hash and the real-hash-match/
   mismatch branches. Reuse the `freshDb`/temp-dir + vitest-spy patterns. **Packaging the real `.exe`
   and a USB-drive launch are MANUAL acceptance steps (R5/R2)** — gate/skip them, don't add them to the
   suite.
8. **Ritual:** docs — extend **`docs/packaging.md`** (electron-builder portable build, the
   `npm run package` command, where weights/binaries are dropped, git-ignored) and **`docs/drive-
   layout.md`** (reconcile the `win/mac/linux` naming with the code; document the scripts), add the
   **user guide** + **troubleshooting** docs, bump `_Last updated_`. Update `BUILD_STATE.md` (mark
   Phase 11 done; add contracts for the scripts + config generators + the packaging config + any new
   dep [`electron-builder`]; note the MVP **Definition of Done** §4 checklist status; set next actions
   = **post-MVP hardening / remaining polish** or "MVP complete"; log decisions [script-logic-in-TS for
   testability, portable-target choice, checksums.json shape, the drive-layout naming reconciliation,
   the deny-by-default config defaults] and risks). Commit referencing **"Phase 11 / Milestone 10"**.

## Notes / gotchas

- **No hardcoded paths; cross-OS drive paths differ.** Scripts take the target root as a parameter and
  use OS-appropriate path joins. Windows is first-class (PowerShell), but ship the `.sh` siblings so
  macOS/Linux stay supported (spec rule). A USB mount is `E:\` on Windows, `/Volumes/...` on macOS,
  `/media/...` on Linux — never assume.
- **Lay out what the CODE reads, not a parallel scheme.** The directory names + the manifest
  `local_path` resolution + the sidecar `llamaOsDir` (`win`/`mac`/`linux`) are the source of truth.
  Reconcile `drive-layout.md` to them (don't let docs and code drift).
- **Never commit weights/binaries/user data.** prepare-drive writes `models/`, `*.gguf`, `runtime/`
  binaries, `logs/`, `workspace/` onto the **drive**, all git-ignored. Re-confirm the ignore patterns
  before relying on them (Phase 10 found one unanchored pattern catching the source tree).
- **Stay offline at runtime.** Packaging must not add a runtime network dependency; the sidecars stay
  on `127.0.0.1`. The only network is **dev-time** (Electron binary download R2, `npm install` R6) and
  the optional, policy-gated model-download path (still deny-by-default; no download feature ships
  unless explicitly built — keep it off).
- **Checksum honesty (R5).** Manifests carry `REPLACE_WITH_REAL_HASH`. verify-models must treat a
  placeholder as **"unverifiable"**, not a pass and not a hard fail (matching `computeInstallState`'s
  developer-mode gate). Real hashes are captured by the **generate** mode once real weights exist.
- **`node:sqlite` needs Electron ≥ 37.** The packaged app must bundle Electron 37 (Node 22.x); a
  downgraded runtime loses `node:sqlite`. Verify the packaged main process can `openDatabase`.
- **Script logic should be testable without a shell.** Put the real layout/config/checksum logic in a
  small TS module (`scripts/lib/*.ts` or a `services/` helper) that the `.ps1`/`.sh` call via `node`,
  so vitest can test the **dry-run plan** + **checksum** branches in CI (no PowerShell dependency).

## ENVIRONMENT NOTES (important)

- **Verify commands** (from repo root): `npm run typecheck`, `npm test`, and
  `NODE_OPTIONS=--use-system-ca npm run build`. **Green = typecheck + test + build.** ESLint is NOT
  installed; `npm run lint` fails by design and is NOT part of green. Live `npm run dev`, the packaged
  `.exe`, and a real USB-drive launch are **manual** steps — don't block on them.
- **All 190 existing tests must stay green.** Platform is Windows/PowerShell; `node:sqlite` lives in
  Electron's bundled Node (Electron 37 / Node 22.21) but tests run under system Node 24 via vitest.
  Rust/Cargo + Python are **NOT installed**. Use the `freshDb` + temp-dir + vitest-spy patterns from
  prior phases. Test **TS helpers**, not the `register*Ipc` modules (they import `electron`) and not the
  shell scripts directly.
- **`electron-builder`** is the likely sole new dependency (dev-only). Install with
  `NODE_OPTIONS=--use-system-ca npm install -D electron-builder` (R6) and record it in BUILD_STATE.
  Producing the actual installer/portable artifact may need dev-time network (R2) and is a manual step.

## END-OF-PHASE RITUAL (mandatory — a phase is not done until this is complete)

1. `npm test` (all green) + `npm run typecheck` (clean) + `NODE_OPTIONS=--use-system-ca npm run
   build` (green).
2. Update affected docs: `docs/packaging.md` (electron-builder portable build + `npm run package`),
   `docs/drive-layout.md` (reconcile `win/mac/linux`; document the scripts), add the **user guide** +
   **troubleshooting** docs, bump `_Last updated_`.
3. Update `BUILD_STATE.md`: mark Phase 11 done, refresh data contracts (scripts + config generators +
   packaging config + `electron-builder` dep), record the **Definition of Done §4** checklist status,
   set next actions (post-MVP polish / "MVP complete"), log new decisions and any risks.
4. Commit referencing **"Phase 11 / Milestone 10"**. Use `git -C f:/_coding/ai_drive` for git (note:
   forward slashes — backslashes get mangled by the Bash tool), and end the commit message with:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   (When committing via the Bash tool, pass the message with a here-doc `-F -`, **not** PowerShell
   `@'...'@`.)

When done, report what was built, test results, the MVP Definition-of-Done status, and what (if
anything) remains manual or post-MVP.
