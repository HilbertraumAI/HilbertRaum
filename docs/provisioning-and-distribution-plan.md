# Provisioning & Distribution — design record (DIY asset loader + plug-and-play drive)

_Status: **IMPLEMENTED** (Phase 12: DIY asset loader · Phase 13: plug-and-play commercial
drive, 2026-06-09). This is the **condensed design record**; the full original plan (research,
implementation sketches, acceptance criteria, source links) lives in git history — see
"History". Remaining work = manual acceptance only (signed builds + the USB §17 demo,
BUILD_STATE §5). Section numbers (§0, §12, §12.3, §13) are stable; code and docs cite them._

The two features this covers:

1. **DIY asset loader (Phase 12, spec §1.3-A):** scripted, SHA-256-verified download of model
   weights + the `llama.cpp` sidecar onto a drive (`fetch-models` / `fetch-runtime` /
   `prepare-drive --with-assets`) for technical users.
2. **Plug-and-play distribution (Phase 13, spec §1.3-B):** the preconfigured commercial drive —
   plug in, double-click, it runs. No Docker, no install, no terminal.

---

## 0. The distribution decision: portable bundled app (not Docker, not an installer)

| Approach | Plug-and-play for a non-technical buyer? | Verdict |
|---|---|---|
| **Docker container** | ❌ Needs Docker Desktop (multi-GB install, admin rights, daemon, paid for larger orgs); GPU passthrough painful on Win/Mac | **Rejected** |
| **System installer** (`.msi`/`.pkg`) | ⚠️ Admin rights, writes to the host, breaks "your data lives on the drive, move it between laptops" (success criterion #10) | **Rejected as default** |
| **Portable bundled app on the drive** (electron-builder `portable` + launcher) | ✅ Plug in → double-click → runs; nothing written to the host; drive movable | **Chosen** |

The classic portable-Electron pitfall (settings leaking into `%APPDATA%`) does not apply:
`resolvePaths()` redirects **all** state (workspace DB, logs, config, models) onto the drive.

**Two realities the design works around:**

- **USB autorun is dead on Windows** (deliberately, since MS08-038). The app cannot and must not
  auto-launch on plug-in; the realistic UX is one unmissable launcher at the drive root
  (`Start Private AI Drive.*` + `READ ME FIRST.txt`).
- **OS gatekeepers are the real friction.** Unsigned binaries from USB trip SmartScreen /
  Gatekeeper — blockers for non-technical users. **Code signing (Win) + signing & notarization
  (mac) is mandatory for the commercial drive**; the unsigned "Run anyway" fallback is
  documented for DIY users in `troubleshooting.md`.

## 12. DIY asset loader (Phase 12) — as shipped

Manifests stay the single source of truth: `ModelManifest` gained an optional `download` block
(url/sha256/size/license_url), and the sidecar (not a model) gets its own pinned
`model-manifests/runtime-sources.yaml` (per-OS/arch/backend builds — since Phase 14
**vulkan-first** with a `cpu/` safety net; see `gpu-support-plan.md` §6 and `model-policy.md`).
Canonical, unit-tested logic lives in `services/assets.ts`; the self-contained
`scripts/fetch-models.{ps1,sh}` + `fetch-runtime.{ps1,sh}` mirror it natively (a drive must be
preparable with no Node/npm). `prepare-drive --with-assets` chains them.

Design rules (all enforced):

- **Verify everything:** every download is SHA-256-checked against the manifest before it counts
  as installed; a real-hash mismatch deletes the partial and exits non-zero; placeholder hashes
  report UNVERIFIED, never a silent pass.
- **Resumable + idempotent:** `curl -C -`/range requests; re-running skips verified artifacts
  (runtime skips are `.paid-runtime.json`-marker-based since Phase 14).
- **License gate:** models without an `approved` `license_review` require
  `--accept-license` (and that flag never counts as the redistribution review).
- **No new heavy deps:** OS-native downloaders only.
- **Build-time network ≠ runtime network:** the `fetch-*` scripts run on the drive-builder's
  online machine; the app itself stays 100 % offline by default.

### 12.3 In-app model download — DEFERRED

A DIY convenience (download a model from the Models screen instead of the CLI). Doubly gated by
policy `network.allow_model_downloads` (deny-by-default) AND the user `allowNetwork` setting;
hidden entirely on commercial drives. **Deferred — not required for DIY acceptance**; the
injected-fetch seam in `assets.ts` is the hook a future implementation reuses.

## 13. Plug-and-play commercial drive (Phase 13) — as shipped

- **Launcher:** per-OS `Start Private AI Drive.{cmd,command}` / `start-private-ai-drive.sh`
  resolve the drive root from **their own location** (`%~dp0` / `dirname "$0"` — drive letters
  change per machine; never hardcoded), set `PAID_DRIVE_ROOT`, and start the portable app.
  Canonical resolver: `services/launcher.ts` `resolveDriveRootFromLauncher` (unit-tested).
- **Signing/notarization:** wired in `electron-builder.yml` (`win.signtoolOptions`,
  `mac.notarize` + hardened runtime + entitlements); all secrets come from env vars /
  git-ignored files on the build machine and never enter the repo. The green gate never signs.
- **Pipeline:** `build-commercial-drive.{ps1,sh}` orchestrate prepare → fetch-models →
  fetch-runtime (all pinned builds) → package/sign (manual) → copy launcher+app+docs →
  verify-models --generate → final posture assertion. Canonical reference:
  `services/commercial-drive.ts` (`planCommercialDrive` + `assertCommercialDrive` — encryption
  required, plaintext off, network denied, every weight VERIFIED, runtime markers + binaries
  match the pin, no user data; fails loudly).
- **First-run polish:** `services/preflight.ts` (writable/free-space/slow-drive, friendly +
  non-blocking) surfaced on Home; encrypted-by-default onboarding kept.

## Risks (still live)

- **Code-signing certs cost money + lead time** (R7) — blocks only the commercial acceptance.
- **Model license redistribution:** a *sold* drive needs redistribution-permitting licenses
  (`model-policy.md` gate); the DIY path downloads from upstream, sidestepping it.
- **llama.cpp release drift:** the pin in `runtime-sources.yaml` is bumped only as a deliberate,
  reviewed change with fresh hashes (procedure in `model-policy.md`).

## History

- **Phase 12 + 13 implemented 2026-06-09** (see BUILD_STATE §3 for the locked decisions:
  launcher root resolution, signing-as-manual-step, pipeline + posture assertion, build-time vs
  runtime network).
- Phase 14 (GPU distribution) later made the runtime fetch **vulkan-first** with marker-based
  idempotency — recorded in `gpu-support-plan.md`, not here.
- The **full original plan** (Docker research + sources, yaml sketches, acceptance criteria):
  `git show 4549934:docs/provisioning-and-distribution-plan.md`.
