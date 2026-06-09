# Phase 12 kickoff prompt — DIY asset loader (`fetch-assets`)

> Paste this as the kickoff prompt for the next session. It mirrors the Phase 8/9/10/11 handoff style.

---

You are continuing work on the **Private AI Drive Lite** project (an open-source, offline,
local-LLM desktop app) located at `f:\_coding\ai_drive`. Phases 0–11 (the MVP) are complete and
committed; this is the first **post-MVP** phase.

## START BY READING, IN THIS ORDER

1. **`BUILD_STATE.md`** — the live handoff/state file (current status, decisions, data contracts,
   risks). Source of truth for where we are. Read especially: the **Models + runtime (Phase 2 live)**
   contract (`resolveManifestsDir`/`PAID_MANIFESTS_DIR`, `sha256File`, `verifyChecksum`,
   `computeInstallState`, `weightPath`, the `REPLACE_WITH_REAL_HASH` placeholder gate,
   `isRealSha256`), the **Workspace/paths** contract (`resolvePaths`, `PAID_DRIVE_ROOT`,
   `config/drive.json` marker), the **Drive layout, scripts & packaging (Phase 11 live)** contract
   (`services/drive.ts` = the canonical, unit-tested layout/config reference; `DRIVE_LAYOUT_DIRS`;
   `planPrepareDrive`/`formatPlan`; `verifyDriveModels`; `buildChecksumsJson`; the
   **self-contained-scripts** decision — a drive must be preparable on a machine with **no Node/npm**,
   so `scripts/*.{ps1,sh}` re-implement the TS plan natively), the **Privacy & offline policy
   (Phase 8 live)** contract (`loadPolicy`, deny-by-default `network.allow_model_downloads = false`,
   the loopback exception, the offline guard), and the **Real runtime + embedder (Phase 10 live)**
   sidecar discovery contract (`resolveLlamaServerPath` → `runtime/llama.cpp/<os>/llama-server[.exe]`,
   `llamaOsDir` = `win`/`mac`/`linux`).
2. **`docs/provisioning-and-distribution-plan.md`** — **THE PLAN FOR THIS PHASE.** Read all of
   **Phase 12** (§12.1–§12.4) plus **§0** (the Docker-vs-installer decision context). It defines:
   the optional manifest `download` block, the new `runtime-sources.yaml`, the `fetch-models` /
   `fetch-runtime` scripts, the `prepare-drive --with-assets` flag, the optional (deferrable) in-app
   downloader, and the acceptance criteria. **This phase implements §12; follow it.**
3. **`docs/IMPLEMENTATION_PLAN.md`** — the **Phases 12–13** section (the short pointer) + the
   **Per-phase ritual (§3)** + the **§4b "honesty about scope"** note (real artifacts are not in the
   repo; tests must mock the network and stay green with zero weights/binaries present).
4. **`CLAUDE.md`** — the hard rules: **no cloud dependencies / no telemetry / no hosted AI APIs**,
   keep the app **fully usable with no internet**, **never commit model weights / binaries / user
   data / logs / generated files**, **no hardcoded developer-specific absolute paths**, **don't
   assume the drive path is identical across OSes**, **Windows first-class + keep macOS/Linux
   supported**. ⚠️ Phase 12 introduces the project's **first deliberate network access** (the
   `fetch-*` scripts download weights + binaries) — this is allowed because it runs on the **drive
   builder's machine at build time, NOT in the app at runtime**. The *app* must stay 100% offline by
   default; the in-app download path (if built at all) stays **policy-gated + deny-by-default**.
5. **`docs/model-policy.md`** + **`docs/packaging.md`** + **`docs/drive-layout.md`** — the model
   manifest/license rules, the drive layout (`models/...`, `runtime/llama.cpp/<os>/`,
   `model-manifests/`), and the "artifacts are git-ignored, dropped in manually (R5)" status that this
   phase **automates**.
6. **`CLAUDE_Private_AI_Drive_Lite_MVP.md`** — for *what* to build: **§3.3** (the manifest example,
   which includes a `download_url` field — the implemented validator dropped it; Phase 12 reintroduces
   it as a richer `download` block), **§6** (drive layout), **§12.1** (DIY developer package /
   `prepare-drive`), **§13** (model licensing rules — the license gate before download).

## CONTEXT: Phases 0–11 are complete + committed (latest commit `5bf2db0` "audit and polishing")

The MVP is feature-complete. Phase 11 shipped the `prepare-drive`/`verify-models`/`setup-dev` scripts
(`.ps1` + `.sh`), the `config/{drive,policy,checksums}.json` generators, and the `electron-builder`
portable build. **The known gap (R5):** `prepare-drive` lays out the directory tree and config but
**does not download any model weights or `llama.cpp` sidecar binaries** — the builder drops them in by
hand. **Phase 12 closes that gap** with a scripted, verifiable downloader.

### Things already in place for Phase 12 (do NOT rebuild — extend/reuse)

- **`apps/desktop/src/shared/manifest.ts`** — `ModelManifest` + `validateManifest` (hand-written,
  per-field error messages) + `isRealSha256`. **Phase 12 adds an OPTIONAL `download` block** here
  (validated only when present, so all existing manifests stay valid). Check the actual YAML in
  `model-manifests/chat/*` + `model-manifests/embeddings/*` — they may carry a `download_url: null`
  the current validator ignores; replace/extend with the `download:` block from the plan §12.1.
- **`apps/desktop/src/main/services/models.ts`** — `sha256File(path)` (streams large GGUFs),
  `verifyChecksum(path, expected)`, `weightPath(root, manifest)` (rejects `..`/absolute escapes),
  `resolveManifestsDir`, `discoverManifests`. **Reuse `sha256File`/`verifyChecksum`/`weightPath`
  semantics** so the downloader, `verify-models`, and the app all agree on hashing + paths.
- **`apps/desktop/src/main/services/drive.ts`** — the canonical, unit-tested drive-prep reference the
  scripts mirror (`DRIVE_LAYOUT_DIRS`, `planPrepareDrive`, `verifyDriveModels`, `buildChecksumsJson`).
  **Put the new asset-planning logic in the same style** — see the task below.
- **`apps/desktop/src/main/services/runtime/sidecar.ts`** — `llamaOsDir` (`win`/`mac`/`linux`) +
  `llamaServerBinaryName` (`llama-server.exe` on Windows, else `llama-server`) define **where
  `fetch-runtime` must place the extracted binary** (`runtime/llama.cpp/<os>/`).
- **`apps/desktop/src/main/services/policy.ts`** — `loadPolicy` + the deny-by-default
  `network.allow_model_downloads = false`. If you build the optional in-app downloader, it gates on
  **this flag AND** the user `allowNetwork` setting.
- **`scripts/prepare-drive.{ps1,sh}`** + **`scripts/verify-models.{ps1,sh}`** — Phase 11, self-contained
  (no Node needed). **Add a `--with-assets`/`-WithAssets` flag to `prepare-drive`** and the new
  `fetch-*` scripts in the **same dual-shell, self-contained style** (native `curl`/`Invoke-WebRequest`,
  no new npm deps in the scripts).
- **Verify commands** unchanged: `npm run typecheck`, `npm test`, `NODE_OPTIONS=--use-system-ca npm
  run build`. **ESLint is NOT installed** — `npm run lint` fails by design and is NOT part of green.

## YOUR TASK: Implement Phase 12 — "DIY asset loader (`fetch-assets`)" (plan §12)

Follow `docs/provisioning-and-distribution-plan.md` §12, in order:

1. **Extend the manifest schema (`shared/manifest.ts`) with an optional `download` block.** Additive +
   optional → existing manifests still validate. Shape (plan §12.1):
   ```yaml
   download:
     url: https://huggingface.co/.../qwen3-4b-instruct-q4.gguf?download=true
     sha256: <hash>          # when real, must equal the top-level sha256
     size_bytes: 2700000000
     license_url: https://...
   ```
   Validate each sub-field only if the `download` block is present (URL non-empty string;
   `sha256` lower-cased + `isRealSha256`-checked when not a placeholder; `size_bytes` a non-negative
   number; `license_url` optional string). Add unit tests for present/absent/malformed `download`.
   Update the committed `model-manifests/*` YAML with real upstream URLs (Qwen3 GGUF + multilingual-E5)
   — leave `sha256` as the existing placeholder if real hashes aren't known yet (a placeholder means
   "fetch then capture via verify-models --generate").
2. **New committed `model-manifests/runtime-sources.yaml` + a validator.** One entry per OS/arch/backend
   for the `llama.cpp` sidecar (plan §12.1): pin a `ggml-org/llama.cpp` release `version` tag; each
   build has `os` (`win`/`mac`/`linux`), `arch`, `backend`, `url` (the GitHub release zip), `sha256`,
   and `extract_to` (`runtime/llama.cpp/<os>`). **Default backend = CPU** (AVX2 on Windows x64, Metal
   on mac arm64, plain CPU on linux x64) — the broadest-compatible default for an unknown laptop; GPU
   builds are an opt-in override, not the default. Add a small validator (mirror `validateManifest`
   style) + tests.
3. **`apps/desktop/src/main/services/assets.ts` (new) — the canonical, unit-tested logic.** Mirror
   `drive.ts`. Pure/testable functions (no real network; take an injected `fetch`/download fn for
   tests):
   - `planModelDownloads(root, manifests, opts) → DownloadTask[]` (each task: source URL, dest path via
     `weightPath`, expected sha256, present+verified? → skip).
   - `selectRuntimeBuild(sources, { os, arch, backend? }) → RuntimeBuild | null` (host-match + overrides;
     default CPU backend).
   - `planRuntimeDownload(root, build) → { url, zipDest, extractTo, binaryPath, sha256 }`.
   - verification helpers reusing `sha256File`/`verifyChecksum`; a license-gate predicate (refuse to
     plan a download whose manifest `license_review.status` is not `approved` unless an
     `--accept-license`/dev override is set; warn on placeholder hashes).
   - the `formatPlan`-style dry-run report.
   **Do the real network I/O only in the scripts** (or behind an injected fn) so the vitest suite stays
   network-free.
4. **`scripts/fetch-models.{ps1,sh}` (new).** For each chat/embedding manifest with a `download` block:
   download the weight to its `models/...` path with **resume** (`curl -C -` / `Invoke-WebRequest`
   range / re-request), then **SHA-256-verify against the manifest** before counting it installed; a
   mismatch deletes the partial and **exits non-zero**. Skip already-present-and-verified files
   (idempotent). Flags: `-Target`/`--target` (required), `-Only <id>`/`--only`, `-AcceptLicense`/
   `--accept-license`, `-DryRun`/`--dry-run`. Self-contained (native downloader; no Node/npm needed).
5. **`scripts/fetch-runtime.{ps1,sh}` (new).** Read `runtime-sources.yaml`, pick the entry matching the
   host OS/arch (or `-Os/-Arch/-Backend` overrides), download the zip, **SHA-256-verify**, unzip into
   `runtime/llama.cpp/<os>/` (`Expand-Archive` on Windows; `unzip`/`ditto` on mac/linux), and
   `chmod +x` the binary on mac/linux. Idempotent; `-DryRun`/`--dry-run`.
6. **`prepare-drive --with-assets`/`-WithAssets` flag.** After laying out the tree, invoke
   `fetch-models` + `fetch-runtime` so one command yields a launch-ready drive. Without the flag,
   behaviour is unchanged. After fetching, point the user at `verify-models --generate` to capture real
   hashes into `config/checksums.json`.
7. **OPTIONAL / DEFERRABLE — in-app model download (plan §12.3).** A **Models-screen** "download" action
   gated by `policy.network.allow_model_downloads` **AND** the user `allowNetwork` setting (hidden on a
   commercial drive where the policy denies it), streaming progress, writing to `models/...`, SHA-256
   verifying, then flipping the model to `installed`, and **logging the remote host it hit** (the one
   explicit, user-initiated exception to the offline guard). **If time-boxed, SKIP this and note it as
   deferred** — it is not required for the DIY acceptance criteria.
8. **Tests (keep all existing green — run `npm test` first to capture the baseline count).** Unit-test
   `assets.ts` with an **injected/mocked** download fn (no real network): the model-download plan
   (present→skip, missing→fetch, placeholder-vs-real hash, license gate), runtime-build selection
   (host-match + overrides + default CPU backend), the dry-run report, and the manifest+`runtime-sources`
   validators (present/absent/malformed `download` block). Add a tiny temp-file + known-SHA-256 fixture
   for the verify branch (reuse the `freshDb`/temp-dir patterns). **The no-network assertion must still
   hold for the suite.** The actual downloads + a real launch are **manual** (R5) — do not add them.
9. **Ritual:** update docs — `docs/packaging.md` + `docs/drive-layout.md` (the `fetch-*` scripts +
   `--with-assets` flow), `docs/model-policy.md` (the `download` block + license gate), and the
   `docs/provisioning-and-distribution-plan.md` Phase 12 status (PLAN → done), bump `_Last updated_`.
   Update `BUILD_STATE.md` (add a "Provisioning / asset loader (Phase 12 live)" contract section; log
   decisions [the `download` block shape, `runtime-sources.yaml`, default CPU backend, build-time vs
   runtime network distinction, the license gate, in-app downloader built-or-deferred] + any new risks).
   Commit referencing **"Phase 12"**.

## Notes / gotchas

- **Build-time network ≠ runtime network.** The `fetch-*` scripts run on the builder's online machine.
  This does **not** weaken the app's offline guarantee — the *app* never auto-downloads; the optional
  in-app path is deny-by-default + policy-gated. Make this distinction explicit in the docs so the
  privacy story stays intact.
- **Verify before trust.** Every downloaded artifact is SHA-256-checked **before** it is treated as
  installed; a mismatch removes the partial and fails loudly. Never place an unverified file where the
  app's `verifyChecksum` would later silently accept it. Placeholder manifest hashes → "unverified"
  (fetch + then `verify-models --generate`), never a silent pass.
- **Resumable + idempotent.** GGUFs are multi-GB over flaky links — resume (don't restart), and
  re-running must skip present+verified files fast.
- **No hardcoded paths; cross-OS.** Scripts take the target root as a parameter; Windows is first-class
  (PowerShell) but ship `.sh` siblings. `win/mac/linux` sidecar dirs + `weightPath` model dirs are the
  source of truth (match `drive.ts`/`sidecar.ts`, don't invent a parallel scheme).
- **No new npm deps for the scripts** (native `curl`/`Invoke-WebRequest`/`Expand-Archive`/`unzip`).
  Optionally *detect* `aria2c`/`huggingface-cli` and use them if present, but never *require* them.
  If `assets.ts` needs YAML parsing it already has the externalized `yaml` package.
- **License gate (spec §13).** Print the model license + `license_url` and require `--accept-license`
  before the first download; warn when `license_review.status != approved`. A *sold* drive needs a
  redistribution-permitting license (Qwen3 = Apache-2.0; verify E5) — but the DIY `fetch-*` path pulls
  from the upstream source, which sidesteps redistribution.
- **Never commit the downloaded artifacts.** Weights (`*.gguf`, `models/`), the runtime zips/binaries
  (`runtime/`), and `config/checksums.json` are git-ignored and live on the **drive**. Re-confirm the
  ignore patterns (Phase 10 found an unanchored pattern catching the source tree).

## ENVIRONMENT NOTES (important)

- **Verify commands** (from repo root): `npm run typecheck`, `npm test`, `NODE_OPTIONS=--use-system-ca
  npm run build`. **Green = typecheck + test + build.** ESLint is NOT installed; `npm run lint` fails by
  design and is NOT part of green. Live `npm run dev`, the real downloads, and a USB-drive launch are
  **manual** steps — don't block on them.
- **All existing tests must stay green.** Run `npm test` first to capture the current baseline count
  (Phase 9/§9 hardening was at 247; the later "audit and polishing" commit may differ — use the live
  number, don't assume). Platform = Windows/PowerShell; `node:sqlite` lives in Electron 37's Node but
  vitest runs under system Node 24. Rust/Cargo + Python are **NOT installed**. Test **TS helpers**
  (`assets.ts`, the validators), **not** the `register*Ipc` modules (they import `electron`) and **not**
  the shell scripts directly. Reuse `freshDb` + temp-dir + vitest-spy patterns.
- **R6 (TLS-intercepting proxy):** prefix installs/builds with `NODE_OPTIONS=--use-system-ca`.

## END-OF-PHASE RITUAL (mandatory — a phase is not done until this is complete)

1. `npm test` (all green) + `npm run typecheck` (clean) + `NODE_OPTIONS=--use-system-ca npm run build`
   (green).
2. Update affected docs: `docs/packaging.md`, `docs/drive-layout.md`, `docs/model-policy.md`, and the
   Phase 12 status in `docs/provisioning-and-distribution-plan.md`; bump `_Last updated_`.
3. Update `BUILD_STATE.md`: add the Phase 12 "asset loader" data contract, log decisions + risks, set
   next actions (Phase 13 — plug-and-play distribution).
4. Commit referencing **"Phase 12"**. Use `git -C f:/_coding/ai_drive` for git (forward slashes —
   backslashes get mangled by the Bash tool), and end the commit message with:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   (When committing via the Bash tool, pass the message with a here-doc `-F -`, **not** PowerShell
   `@'...'@`.)

When done, report what was built, test results, whether the optional in-app downloader was built or
deferred, and what remains manual (real downloads + USB-drive launch, R5) or for Phase 13.
