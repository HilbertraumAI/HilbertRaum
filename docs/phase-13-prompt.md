# Phase 13 kickoff prompt — Plug-and-play distribution (commercial drive)

> Paste this as the kickoff prompt for the next session. It mirrors the Phase 8/9/10/11/12 handoff style.

---

You are continuing work on the **Private AI Drive Lite** project (an open-source, offline,
local-LLM desktop app) located at `f:\_coding\ai_drive`. Phases 0–12 are complete and committed
(latest: `59ef903` "Phase 12: DIY asset loader"). Phase 13 is the **second post-MVP** phase and the
**last** in the provisioning/distribution plan.

## START BY READING, IN THIS ORDER

1. **`BUILD_STATE.md`** — the live handoff/state file (current status, decisions, data contracts,
   risks). Source of truth for where we are. Read especially: the **Workspace/paths** contract
   (`resolvePaths({envRoot,fallbackRoot})`, `PAID_DRIVE_ROOT`, the `config/drive.json` marker that
   flags a prepared drive, `buildDriveStatus` = writable/free-space/OS-arch), the **Drive layout,
   scripts & packaging (Phase 11 live)** contract (`services/drive.ts` = the canonical, unit-tested
   layout/config reference; `DRIVE_LAYOUT_DIRS`; `buildPolicyJson({dev?})` = the **commercial posture**
   = encryption required + plaintext off + models must verify + **network denied**; `verifyDriveModels`;
   the **portable Windows `.exe` via electron-builder** + `npm run package`/`package:win`; the
   **self-contained-scripts** decision — a drive must be preparable on a machine with **no Node/npm**),
   the **Provisioning / asset loader (Phase 12 live)** contract (`services/assets.ts` canonical logic;
   `scripts/fetch-models.{ps1,sh}` + `fetch-runtime.{ps1,sh}`; `prepare-drive --with-assets`/
   `-WithAssets`; the **license gate** — a *sold* drive needs `license_review.status: approved`), the
   **Privacy & offline policy (Phase 8 live)** contract (`loadPolicy`, deny-by-default network, the
   **build-time-network ≠ runtime-network** decision), the **Encrypted workspace (Phase 9 live)**
   contract (`WorkspaceController`, the `WorkspaceGate` create/unlock screen, `plaintextAllowed` — a
   commercial drive defaults to **encrypted** + onboarding never offers plaintext), and the **Hardware
   benchmark (Phase 7 live)** contract (`measureDriveSpeed`/`buildWarnings` — the slow-drive warning the
   Phase-13 preflight reuses).
2. **`docs/provisioning-and-distribution-plan.md`** — **THE PLAN FOR THIS PHASE.** Read all of
   **Phase 13** (§13.1–§13.5) plus **§0** (the Docker-vs-installer decision — the chosen answer is the
   **portable bundled app + a tiny native launcher**, NOT Docker/installer). It defines: the per-OS
   launcher (`Start Private AI Drive.*`) that sets `PAID_DRIVE_ROOT` from its **own location**, code
   signing + notarization (the make-or-break, mostly-manual task), the `build-commercial-drive` master
   pipeline, the non-technical first-run polish (preflight + onboarding copy), and the acceptance
   criteria. **This phase implements §13; follow it.** Phase 12 is already marked DONE there.
3. **`docs/IMPLEMENTATION_PLAN.md`** — the **Phases 12–13** pointer + the **Per-phase ritual (§3)** +
   the **§4b "honesty about scope"** note (real artifacts/binaries are not in the repo; the green gate
   must stay green with **zero** weights/binaries/certs present; tests mock I/O + the network).
4. **`CLAUDE.md`** — the hard rules: **no cloud dependencies / no telemetry / no hosted AI APIs**, keep
   the app **fully usable with no internet**, **never commit model weights / binaries / user data /
   logs / generated files / signing secrets**, **no hardcoded developer-specific absolute paths**,
   **don't assume the drive path (or drive letter) is identical across machines/OSes**, **Windows
   first-class + keep macOS/Linux supported**. ⚠️ Phase 13's launcher MUST derive the drive root from
   **its own location at runtime** — drive letters change per machine (`E:\` on one laptop, `F:\` on
   the next), so hardcoding any path is a spec violation.
5. **`docs/packaging.md`** + **`docs/drive-layout.md`** — the `electron-builder` portable build, the
   `extraResources` manifests, the `prepare-drive`/`fetch-*`/`verify-models` flow, and the spec §6 drive
   layout (the launcher names `Start Private AI Drive.*` live at the **drive root**, beside the portable
   `.exe`). **`docs/troubleshooting.md`** + **`docs/user-guide.md`** — the SmartScreen/Gatekeeper
   "Run anyway" fallback copy + the non-technical first-run path Phase 13 extends.
6. **`CLAUDE_Private_AI_Drive_Lite_MVP.md`** — for *what* to build: **§6** (drive layout names the
   launchers), **§12.2** (preconfigured commercial drive — ships weights pre-loaded, network denied, no
   user data), **§11.4** (friendly preflight/warning tone — never "your hardware is bad"), **§13** (model
   licensing — a *sold* drive needs a redistribution-permitting license), **§17** (the end-to-end demo
   the commercial drive must complete offline), **§22** (success criterion #10 — the same drive moves
   between laptops and continues the same encrypted workspace).

## CONTEXT: Phases 0–12 are complete + committed (latest `59ef903` "Phase 12")

The MVP is feature-complete and the DIY asset loader ships. Phase 12 added the optional manifest
`download` block, `runtime-sources.yaml`, the canonical `services/assets.ts`, the
`fetch-models`/`fetch-runtime` scripts, and `prepare-drive --with-assets`. **The known gap Phase 13
closes:** there is still **no "one obvious thing to double-click"** for a non-technical buyer, and no
single pipeline that produces a finished, signed, verified sellable drive. The OS gatekeepers
(Windows SmartScreen / macOS Gatekeeper) will block an unsigned USB-launched app for a lawyer — Phase
13 makes the drive *plug-and-play*.

### Things already in place for Phase 13 (do NOT rebuild — extend/reuse)

- **`apps/desktop/src/main/services/workspace.ts`** — `resolvePaths` keys off `PAID_DRIVE_ROOT` + the
  `config/drive.json` marker; `buildDriveStatus` already reports **writable** + **free space** + OS/arch.
  **The launcher sets `PAID_DRIVE_ROOT`; the preflight reuses `buildDriveStatus`.**
- **`apps/desktop/src/main/services/drive.ts`** — `buildPolicyJson()` (the **commercial** posture by
  default) + `verifyDriveModels` (status `verified|unverified_placeholder|mismatch|missing|unsupported`).
  **The final "is this drive sellable?" check asserts the commercial policy + all-VERIFIED weights using
  these.** Put the new commercial-drive *plan/assert* logic in the same style (a tested TS module).
- **`apps/desktop/src/main/services/assets.ts`** (Phase 12) + **`scripts/fetch-models.*`** +
  **`scripts/fetch-runtime.*`** + **`scripts/prepare-drive.* --with-assets`** — the master pipeline
  **orchestrates these**, it does not re-implement them.
- **`apps/desktop/src/main/services/benchmark.ts`** — `measureDriveSpeed(workspacePath)` +
  `buildWarnings(...)` (the spec §11.4 slow-drive copy). **The launch preflight reuses these** — don't
  write a second drive-speed probe.
- **`apps/desktop/src/main/services/workspace-vault.ts`** + **`renderer/screens/WorkspaceGate.tsx`** —
  the encrypted-by-default create/unlock gate a commercial first-run already lands on. **First-run
  polish extends the existing gate copy; it does not add a new onboarding flow.**
- **`apps/desktop/electron-builder.yml`** — the `portable` Windows target + mac(dir)/linux(AppImage).
  **Signing wires into THIS file** (`win.signtoolOptions`, `mac.notarize`) — a documented manual/CI
  step, secrets never in the repo.
- **`docs/troubleshooting.md`** — already has the unsigned "Run anyway" fallback; extend it with the
  illustrated SmartScreen/Gatekeeper step for the commercial guide.
- **Verify commands** unchanged: `npm run typecheck`, `npm test`, `NODE_OPTIONS=--use-system-ca npm run
  build`. **ESLint is NOT installed** — `npm run lint` fails by design and is NOT part of green.

## YOUR TASK: Implement Phase 13 — "Plug-and-play distribution (commercial drive)" (plan §13)

Follow `docs/provisioning-and-distribution-plan.md` §13, in order. The discipline is the same as
Phases 11–12: **put the testable logic in a TS module + mirror it in self-contained scripts; the
inherently-manual parts (signing, notarization, a real USB run) are documented manual acceptance, NOT
part of the green gate.**

1. **The per-OS launcher (§13.1) — resolve the drive root from the launcher's OWN location.** Add a
   small, tested helper (e.g. `services/launcher.ts` `resolveDriveRootFromLauncher(launcherPath)`) that
   derives the drive root from where the launcher sits (next to `config/drive.json` / the portable
   `.exe`), **never** a hardcoded drive letter. Then ship the launchers at the drive root (spec §6
   names): **Windows** `Start Private AI Drive.cmd` (or a signed `.exe`/`.ps1` shim) that resolves its
   own directory (`%~dp0`), sets `PAID_DRIVE_ROOT`, and spawns the portable `.exe`; **macOS**
   `Start Private AI Drive.command` (`cd "$(dirname "$0")"`, export, open the `.app`); **Linux**
   `start-private-ai-drive.sh` next to the AppImage. Add a root `READ ME FIRST.txt` for the
   SmartScreen step. Unit-test the root-resolution helper (Windows + POSIX paths); the launcher scripts
   themselves are smoke-tested, not in the suite.
2. **Code signing & notarization (§13.2) — wire the config, document the manual step.** Add the
   `electron-builder.yml` hooks (`win.signtoolOptions`, `mac.notarize` + `mac.hardenedRuntime`/
   entitlements) **driven by env vars / a secrets file that is git-ignored and never committed**. This
   is mostly process: document in `docs/packaging.md` exactly how a build machine supplies the
   OV/EV Windows cert + the Apple Developer ID + notarization creds, and that the green gate does NOT
   invoke signing (like the R2 electron-builder Electron download). Keep the **unsigned DIY fallback**
   in `docs/troubleshooting.md`.
3. **The `build-commercial-drive` master pipeline (§13.3).** A new `scripts/build-commercial-drive.
   {ps1,sh}` (self-contained, dual-shell) that runs the ordered steps: `prepare-drive` (commercial
   policy) → `fetch-models --accept-license` → `fetch-runtime` → `package` (signed/notarized — manual
   gate) → copy the launcher + portable app + user-guide/privacy/troubleshooting onto the drive →
   `verify-models --generate` → a **final automated check** asserting the **commercial posture**
   (encryption required, network denied) + **all weights VERIFIED** + **no user data present**. Put the
   *plan + the final assertion* in a tested TS module (e.g. `services/commercial-drive.ts`:
   `planCommercialDrive(opts) → Step[]` + `formatPlan`, and `assertCommercialDrive(root, manifests) →
   { ok, problems[] }` reusing `parsePolicy`/`verifyDriveModels`/`buildDriveStatus`). The script mirrors
   the plan natively; the TS module is the canonical, unit-tested reference (like `drive.ts`/`assets.ts`).
4. **Non-technical first-run polish (§13.4).** A **launch preflight** (`services/launcher.ts` or
   `preflight.ts` `runPreflight({ rootPath }) → { writable, freeBytes, slowDriveWarning, problems[] }`)
   reusing `buildDriveStatus` + `measureDriveSpeed`/`buildWarnings` — friendly, **non-blocking** spec
   §11.4 copy ("this drive is a bit slow…", never "bad hardware"). Surface it on first launch
   (Home/onboarding) and point at `docs/troubleshooting.md` for "what to do if it doesn't open". Tighten
   the `WorkspaceGate`/onboarding copy for zero-technical-knowledge users. Keep the encrypted-by-default
   commercial path (don't offer plaintext on a commercial drive).
5. **Tests (keep all existing green — run `npm test` first to capture the baseline; Phase 12 left it at
   287).** Unit-test the **TS helpers**, not the scripts or `register*Ipc`/`main/index.ts` (they import
   `electron`): `resolveDriveRootFromLauncher` (Win drive-letter + POSIX, escape-guarded, no hardcoded
   path), `runPreflight` (writable/free/slow branches with temp dirs + an injected drive-speed fn so the
   **no-network assertion holds**), `planCommercialDrive`/`formatPlan` (the ordered steps), and
   `assertCommercialDrive` (passes on a verified commercial drive; flags network-allowed / plaintext /
   placeholder-or-mismatch weights / present user data). Reuse the `freshDb` + temp-dir + injected-fn
   patterns. The signing, notarization, and the real USB launch are **manual** (R5/new R7) — do not add
   them to the suite.
6. **Ritual:** update docs — `docs/packaging.md` (signing/notarization wiring + the
   `build-commercial-drive` pipeline + the launcher), `docs/drive-layout.md` (the launcher files at the
   drive root + the commercial-drive contents), `docs/troubleshooting.md` (illustrated SmartScreen/
   Gatekeeper step) + `docs/user-guide.md` (the non-technical first run), and the
   `docs/provisioning-and-distribution-plan.md` Phase 13 status (PLAN → done), bump `_Last updated_`.
   Update `BUILD_STATE.md` (status table row for Phase 13; add a "Plug-and-play distribution (Phase 13
   live)" contract section; log decisions [launcher root-resolution, signing-as-manual-step,
   `build-commercial-drive` plan + the final commercial-posture assertion, the preflight reuse of
   benchmark, encrypted-by-default kept] + new risks [R7 code-signing certs cost/lead-time block only
   the *commercial* acceptance, not DIY]). Commit referencing **"Phase 13"**.

## Notes / gotchas

- **Autorun is dead; the launcher must be UNMISSABLE.** Windows disabled `autorun.inf` from removable
  drives — you **cannot** auto-launch on plug-in and must not try (it looks like malware). The realistic
  UX: the drive opens a file window and the user double-clicks one obvious, well-named launcher at the
  root. Name it exactly per spec §6 and add an icon if `buildResources` is set up.
- **Signing is the make-or-break, and it's mostly NOT code.** An unsigned `.exe`/`.app` from USB trips
  SmartScreen/Gatekeeper and a non-technical user gives up. Wire the `electron-builder` hooks, but the
  certs/creds are **procurement + a manual/CI build step** with secrets that **never enter the repo**.
  The green gate does not sign. Track cert cost/lead-time as **R7**.
- **No hardcoded paths; drive letters change.** The launcher derives `PAID_DRIVE_ROOT` from its **own**
  location every launch (`%~dp0` / `dirname "$0"`). The same drive on a second laptop gets a different
  letter/mount and must still continue the **same encrypted workspace** (success criterion #10) — that
  already works because `resolvePaths` redirects all state onto the drive; don't regress it.
- **Commercial posture is non-negotiable.** A sellable drive ships `policy.json` in the **commercial**
  posture (`buildPolicyJson()` default: encryption required, plaintext off, models must verify, **network
  denied**) and contains **no user data** (spec §12.2). `assertCommercialDrive` must FAIL loudly if any
  of those is violated. First launch lands on the existing encrypted-workspace gate.
- **Model license redistribution (spec §13).** Bundling weights on a *sold* drive needs the license to
  permit redistribution (Qwen3 Apache-2.0 is fine; verify E5) AND the manifest `license_review.status`
  must be `approved` (the Phase-12 gate). The DIY `fetch-*` path sidesteps this by downloading upstream;
  the commercial pipeline does NOT — record approved reviews before shipping.
- **Reuse, don't duplicate.** Preflight reuses `benchmark.ts`; the final check reuses `drive.ts` +
  `policy.ts`; the pipeline orchestrates the Phase-11/12 scripts. New code = the launcher root-resolver,
  the preflight aggregator, the commercial-drive plan + assertion, and the launcher/pipeline scripts.

## ENVIRONMENT NOTES (important)

- **Verify commands** (from repo root): `npm run typecheck`, `npm test`, `NODE_OPTIONS=--use-system-ca
  npm run build`. **Green = typecheck + test + build.** ESLint is NOT installed; `npm run lint` fails by
  design and is NOT part of green. Live `npm run dev`, the signed build, notarization, and a USB-drive
  launch are **manual** steps — don't block on them.
- **All existing tests must stay green.** Run `npm test` first to capture the baseline (Phase 12 was at
  **287** — use the live number). Platform = Windows/PowerShell; `node:sqlite` lives in Electron 37's
  Node but vitest runs under system Node 24. Rust/Cargo + Python are **NOT installed**. Test **TS
  helpers**, **not** the `register*Ipc`/`main/index.ts` modules (they import `electron`) and **not** the
  shell scripts directly. ⚠️ **Windows PowerShell 5.1 reads non-BOM `.ps1` files in the ANSI codepage** —
  keep new `.ps1` scripts **pure ASCII** (a UTF-8 em-dash's `0x94` byte decodes to `"` and breaks a
  double-quoted string; the Phase-12 scripts hit exactly this). PS scripts that write JSON must emit
  **UTF-8 without a BOM** (Phase-11 fix).
- **R2 (electron-builder Electron download)** + **R5 (real artifacts not in repo)** + **R6 (TLS-
  intercepting proxy — prefix installs/builds with `NODE_OPTIONS=--use-system-ca`)** still apply. Add
  **R7 (code-signing certs)** as a procurement risk that blocks only the *commercial* acceptance.

## END-OF-PHASE RITUAL (mandatory — a phase is not done until this is complete)

1. `npm test` (all green) + `npm run typecheck` (clean) + `NODE_OPTIONS=--use-system-ca npm run build`
   (green).
2. Update affected docs: `docs/packaging.md`, `docs/drive-layout.md`, `docs/troubleshooting.md`,
   `docs/user-guide.md`, and the Phase 13 status in `docs/provisioning-and-distribution-plan.md`; bump
   `_Last updated_`.
3. Update `BUILD_STATE.md`: status table row, the Phase 13 "plug-and-play distribution" data contract,
   decisions + risks (R7), and next actions (this is the last planned phase — note remaining manual
   acceptance: signed build + notarization + a real USB-drive §17 demo on a fresh laptop with Wi-Fi off,
   and the second-laptop continuity check).
4. Commit referencing **"Phase 13"**. Use `git -C f:/_coding/ai_drive` for git (forward slashes —
   backslashes get mangled by the Bash tool), and end the commit message with:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   (When committing via the Bash tool, pass the message with a here-doc `-F -`, **not** PowerShell
   `@'...'@`.)

When done, report what was built, test results, what was wired vs. left manual (signing/notarization/
USB run, R5/R7), and confirm the commercial-posture final check passes on a (mock) verified drive.
