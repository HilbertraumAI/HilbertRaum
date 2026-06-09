# Provisioning & Distribution Plan — DIY asset loader + plug-and-play drive

_Last updated: 2026-06-09 — proposed (Phases 12–13). Status: PLAN, not yet implemented._

This plan covers the two pieces of "polish" that turn the feature-complete MVP into something
others can actually obtain and run:

1. **Feature A — DIY asset loader (Phase 12).** A scripted, verifiable way for *technical* users
   (the open-source path, spec §1.3-A) to **download the model weights and the `llama.cpp`
   sidecar binaries** onto a drive. Today [`scripts/prepare-drive.*`](../scripts) lays out the
   directory tree and config but **explicitly does not fetch any artifacts** — the builder drops
   them in by hand (BUILD_STATE R5). Phase 12 automates that download + verification step.

2. **Feature B — Plug-and-play distribution (Phase 13).** Make the *preconfigured commercial
   drive* (spec §1.3-B) work for **non-technical users** (lawyers, etc.): plug in, double-click,
   it runs — no Docker, no install, no terminal. This phase decides the distribution mechanism,
   builds the per-OS launcher, and ties everything into one "build a sellable drive" pipeline.

> Read [`BUILD_STATE.md`](../BUILD_STATE.md) and [`packaging.md`](packaging.md) first — they
> describe the Phase 10/11 runtime layout, the `electron-builder` portable build, and the
> `prepare-drive`/`verify-models` scripts these phases extend.

---

## 0. Research summary & the key decision (Docker vs install vs portable)

The user's open question was: *how do we make a plug-and-play drive — an install script, or a
Docker container?* The research below (sources at the end) says **neither a Docker container nor
a system installer**; the right answer is a **fully self-contained portable app pre-bundled on the
drive**, launched by a tiny native launcher. The MVP architecture is already built for this.

### Option comparison

| Approach | Plug-and-play for a lawyer? | Offline? | Verdict |
|---|---|---|---|
| **Docker container** (Docker Desktop + image) | ❌ Requires installing Docker Desktop (multi-GB, admin rights, reboot), starting a daemon, GPU passthrough is painful on Win/Mac, and Docker Desktop needs a **paid subscription** for orgs >250 staff / >$10M revenue. A non-technical user cannot do this. | ⚠️ Only after a large online install | **Rejected** |
| **System installer** (`.msi`/`.pkg` install script) | ⚠️ Better, but writes to `Program Files`/registry, needs admin rights, and breaks the "your data lives on the drive, move it between laptops" promise (spec success criterion #10). Leaves traces on the host — wrong for a privacy product. | ✅ | **Rejected as default** (kept as an optional advanced path) |
| **Portable bundled app on the drive** (electron-builder `portable` + launcher) | ✅ Plug in → double-click `Start Private AI Drive` → runs. No admin rights, no install, nothing written to the host, drive is movable. | ✅ Fully | **Chosen** |

This matches what Phase 11 already shipped: a `portable` Windows `.exe` target, all app data
resolved to the drive root via `PAID_DRIVE_ROOT` + the `config/drive.json` marker
([`packaging.md`](packaging.md), [`drive-layout.md`](drive-layout.md)). The research's main warning
about portable Electron apps — that they leak settings into `%APPDATA%` and so aren't truly
portable — **does not apply to us**, because `resolvePaths()` already redirects *all* state
(workspace DB, logs, config, models) onto the drive. That is the hard part, and it is done.

### Two realities we must design around

- **Autorun/AutoPlay is dead for USB on Windows.** Microsoft disabled `autorun.inf` execution from
  removable drives (post-Win7, MS08-038 era) precisely because it was a malware vector. **We cannot
  make the app launch automatically on plug-in**, and we should not try (it would look like
  malware). The realistic "plug-and-play" UX is: the drive opens in a file window and the user
  double-clicks one obvious launcher. So the launcher must be **unmissable** (named
  `Start Private AI Drive`, with an icon, at the drive root).
- **OS gatekeepers are the real friction, not packaging.** An unsigned `.exe` from a USB stick
  triggers **Windows SmartScreen** ("Windows protected your PC"); an unsigned `.app` triggers
  **macOS Gatekeeper** quarantine ("can't be opened / damaged"). For non-technical users these
  dialogs are blockers. **Code signing (Windows) + signing & notarization (macOS) is mandatory for
  the commercial drive**, and is the single most important non-code task in Phase 13.

---

## Phase 12 — DIY asset loader (`fetch-assets`)

**Goal:** a technical user with a fresh clone and an internet connection can run a single command
and end up with a drive that has verified weights + the right `llama-server` binary in the right
places, ready to launch. This closes the R5 "artifacts not in the repo" gap for the DIY path.

### 12.1 Source of truth: extend the manifests, add a runtime-sources file

The app already reads [`model-manifests/`](../model-manifests) and verifies each weight's
`sha256`. Today the schema has `localPath` + `sha256` but **no download location** (the spec §3.3
example had `download_url`; the implemented [`manifest.ts`](../apps/desktop/src/shared/manifest.ts)
dropped it). Phase 12 adds **optional** download metadata so the manifest stays the single source
of truth and the app/scripts agree on what to fetch.

- **Extend `ModelManifest`** (additive, optional → existing manifests stay valid):
  ```yaml
  download:
    url: https://huggingface.co/.../qwen3-4b-instruct-q4.gguf?download=true
    sha256: <real-hash>          # must equal the top-level sha256 once known
    size_bytes: 2700000000
    license_url: https://...      # for the license-acceptance prompt
  ```
  `validateManifest` gains an optional `download` block (validated only if present). When a real
  `download.sha256` is filled in, it becomes the real top-level `sha256` too (resolves the
  `REPLACE_WITH_REAL_HASH` placeholders BUILD_STATE notes).
- **New `model-manifests/runtime-sources.yaml`** — the sidecar binaries are *not* models, so they
  get their own committed manifest, one entry per OS/arch/backend:
  ```yaml
  llama_cpp:
    version: b9196                     # pinned ggml-org/llama.cpp release tag
    builds:
      - os: win   arch: x64  backend: cpu-avx2
        url: https://github.com/ggml-org/llama.cpp/releases/download/b9196/llama-b9196-bin-win-avx2-x64.zip
        sha256: <hash>
        extract_to: runtime/llama.cpp/win
      - os: mac   arch: arm64 backend: metal
        url: .../llama-b9196-bin-macos-arm64.zip
        sha256: <hash>
        extract_to: runtime/llama.cpp/mac
      - os: linux arch: x64  backend: cpu
        url: .../llama-b9196-bin-ubuntu-x64.zip
        sha256: <hash>
        extract_to: runtime/llama.cpp/linux
  ```
  **Default backend = CPU (AVX2 on Windows, Metal on Apple Silicon, plain CPU on Linux x64.)**
  Rationale (research): CPU builds run everywhere with zero driver assumptions — the right default
  for a portable drive that must boot on an unknown laptop. GPU builds (CUDA/Vulkan) are an
  **opt-in flag**, not the default, because a mismatched GPU build fails or runs worse than CPU.

### 12.2 The scripts: `fetch-models` + `fetch-runtime` (+ a `--with-assets` flag on prepare-drive)

Add to [`scripts/`](../scripts), in the **same self-contained, dual `.ps1`/`.sh`** style as the
existing scripts (a drive must be preparable on a machine with no Node/npm — BUILD_STATE Phase 11
decision). Logic mirrors a new unit-tested `services/assets.ts` (the canonical reference), exactly
as `prepare-drive` mirrors `drive.ts`.

| Script | Job |
|---|---|
| `fetch-models.{ps1,sh}` | For each chat/embedding manifest with a `download` block: download the weight to its `models/...` path, **resume** partial downloads (HTTP Range / `curl -C -` / `Invoke-WebRequest` range), then **SHA-256 verify against the manifest**. Skip if already present + verified. `--only <id>` to fetch one model. |
| `fetch-runtime.{ps1,sh}` | Read `runtime-sources.yaml`, pick the entry matching the host OS/arch (or `--os/--arch/--backend` overrides), download the zip, verify SHA-256, unzip into `runtime/llama.cpp/<os>/`, mark the binary executable (`chmod +x` on mac/linux). |
| `prepare-drive.{ps1,sh}` `--with-assets` | New flag: after laying out the tree, invoke `fetch-models` + `fetch-runtime` so one command produces a ready drive. Without the flag, behaviour is unchanged. |

Design rules (carry the existing ethos):
- **Verify everything.** Every downloaded file is SHA-256-checked against the manifest before it
  counts as installed; a mismatch deletes the partial and exits non-zero (mirrors
  `verify-models` exit-1-on-mismatch). After fetching, `verify-models --generate` still records
  the captured hashes into `config/checksums.json`.
- **Resumable + idempotent.** Big GGUF files over flaky connections must resume, not restart
  (research: HF/aria2/`curl -C -` all support this). Re-running is safe and fast (present+verified
  → skip).
- **License gate.** Before the first download, print the model license + `license_url` and require
  `--accept-license` (or an interactive `y`). A weight whose manifest `license_review.status` is
  not `approved` prints a warning (consistent with the commercial-drive gate in
  [`model-policy.md`](model-policy.md)).
- **No new heavy deps.** Use the OS-native downloader (`curl`/`Invoke-WebRequest`) — already
  present on Win10+/mac/linux. Optionally *detect* `aria2c`/`huggingface-cli` and use them if
  present (faster, multipart) but never *require* them.

### 12.3 Optional: in-app model download (opt-in, policy-gated)

A nice-to-have for the DIY path so a user who launched with no chat model can fetch one from the
**Models** screen instead of the CLI. This must obey the existing privacy posture:

- Gated by the policy flag `network.allow_model_downloads` (default **false** — deny-by-default,
  [`policy.ts`](../apps/desktop/src/main/services/policy.ts)) **and** the user `allowNetwork`
  setting. On a commercial drive (`policy.json` denies downloads) this UI is hidden entirely.
- New IPC `downloadModel(modelId)` streaming progress over an event channel (reuse the
  Phase-3 streaming contract pattern), writing to `models/...`, SHA-256 verifying, then flipping
  the model to `installed`. The offline guard already permits only loopback otherwise; this is the
  **one** explicit, user-initiated, policy-checked exception and must log the remote host it hit.
- **Out of scope for the commercial product** (those drives ship with weights pre-loaded and
  network denied). This is purely a DIY convenience and can be deferred if time-boxed.

### 12.4 Acceptance criteria (Phase 12)

- `fetch-models` + `fetch-runtime` download, **resume**, and **SHA-256-verify** weights + the
  matching sidecar into the correct drive paths; mismatch → non-zero exit, partial removed.
- `prepare-drive --with-assets` produces a launch-ready drive in one command on Win + mac/linux.
- `verify-models` reports all fetched artifacts **VERIFIED** (real hashes, not placeholders).
- Manifest schema accepts the optional `download` block; all existing manifests still validate.
- `services/assets.ts` is unit-tested (URL/path planning, OS/arch selection, verify logic) with a
  **mocked** fetch — **no real network in the test suite** (the no-network assertion still holds).
- Docs updated: [`packaging.md`](packaging.md) + [`drive-layout.md`](drive-layout.md) +
  [`model-policy.md`](model-policy.md); BUILD_STATE decision log + data contract.

---

## Phase 13 — Plug-and-play distribution (commercial drive)

**Goal:** a non-technical buyer plugs in the drive, double-clicks one icon, and is chatting with
their documents — offline, no install, no terminal, on Windows or macOS.

### 13.1 The launcher (per-OS, sets `PAID_DRIVE_ROOT`)

The portable build already exists ([`packaging.md`](packaging.md)); what's missing is the
**one obvious thing to double-click** that sets `PAID_DRIVE_ROOT` to the drive root and starts the
portable app (spec §6 drive layout names these `Start Private AI Drive.*`).

- **Windows** — `Start Private AI Drive.exe`: a tiny launcher (or a code-signed `.cmd`→exe shim)
  that resolves its own drive letter at runtime, sets `PAID_DRIVE_ROOT`, and spawns the portable
  `.exe`. Drive letters change per machine, so the launcher must derive the root from **its own
  location**, never hardcode `E:\` (spec rule: no hardcoded paths).
- **macOS** — `Start Private AI Drive.command` (or a `.app` wrapper) that `cd`s to its directory,
  exports `PAID_DRIVE_ROOT`, and opens the bundled `.app`.
- **Linux** — `start-private-ai-drive.sh` next to the AppImage.
- A short, friendly `READ ME FIRST.txt` / `docs/user-guide` at the root for the SmartScreen step.

### 13.2 Code signing & notarization (the make-or-break task)

Without this, non-technical users hit a scary OS dialog and give up. This is mostly process, not code:

- **Windows:** sign the launcher + portable `.exe` with an **OV/EV code-signing certificate**
  (EV builds SmartScreen reputation fastest). Wire `electron-builder`'s `win.signtoolOptions`.
- **macOS:** sign with a **Developer ID Application** cert + **notarize** + **staple**
  (`electron-builder` `mac.notarize`). Without notarization a USB-launched `.app` is quarantined.
- **Document the unsigned fallback** for DIY users in [`troubleshooting.md`](troubleshooting.md)
  ("More info → Run anyway" / right-click → Open) — acceptable for technical users, not for the
  commercial drive.
- Signing happens on the build machine with secrets that **never enter the repo**; keep it a
  documented manual/CI step (like the electron-builder Electron download, R2).

### 13.3 The "build a sellable drive" pipeline

One master script that a drive-builder runs to produce a finished, verified, signed drive — tying
Phase 11 + Phase 12 + signing together:

```
build-commercial-drive: 
  prepare-drive  --target <drive>            # layout + commercial policy.json (encrypted, network off)
  fetch-models   --target <drive> --accept-license   # verified weights (Phase 12)
  fetch-runtime  --target <drive>            # verified sidecar for each shipped OS (Phase 12)
  package        (signed portable .exe / signed+notarized .app)   # Phase 11 + 13.2
  copy launcher + portable app + user-guide/privacy/troubleshooting onto the drive
  verify-models  --target <drive> --generate # capture real hashes → config/checksums.json
  final check: assert encrypted-workspace policy, network denied, all weights VERIFIED
```

Commercial drives ship `policy.json` in the **commercial posture** (encryption required, plaintext
off, models must verify, **network denied** — Phase 11 default) and contain **no user data**
(spec §12.2). The first launch lands on the existing onboarding → encrypted-workspace gate.

### 13.4 Non-technical first-run polish

- Onboarding copy assuming zero technical knowledge; the SmartScreen/Gatekeeper step illustrated in
  the bundled user guide.
- A **preflight check** on launch: drive writable? enough free space? known-slow drive warning
  (Phase 7 already measures this) — friendly, non-blocking messages (spec §11.4 tone).
- Clear "what to do if it doesn't open" pointing at `docs/troubleshooting.md`.

### 13.5 Acceptance criteria (Phase 13)

- Double-clicking the launcher on a fresh Windows + macOS laptop (Wi-Fi off) starts the app, which
  reads models/workspace from the drive — **no install, no admin rights, no terminal**.
- Signed Windows build does **not** trip SmartScreen; signed+notarized macOS build opens without a
  Gatekeeper block.
- `build-commercial-drive` produces a drive that passes a final automated check (encrypted policy,
  network denied, weights VERIFIED) and completes the spec §17 demo end-to-end.
- The same drive moved to a second laptop continues the same (encrypted) workspace (success
  criterion #10).
- Docs updated: [`packaging.md`](packaging.md), [`drive-layout.md`](drive-layout.md),
  [`troubleshooting.md`](troubleshooting.md), [`user-guide.md`](user-guide.md); BUILD_STATE.

---

## Risks & open questions

- **Code-signing certs cost money + lead time** (esp. EV/Apple Developer). Blocks the *commercial*
  acceptance criteria, not the DIY path. Track as a procurement task.
- **Model license redistribution.** Bundling weights on a *sold* drive needs the license to permit
  it (Qwen3 Apache-2.0 is fine; verify each — [`model-policy.md`](model-policy.md) gate). The DIY
  `fetch-*` path downloads from the upstream source, sidestepping redistribution.
- **`llama.cpp` release URL/version drift.** Pin a release tag in `runtime-sources.yaml`; bumping it
  is a deliberate, reviewed change with fresh hashes.
- **CPU-feature mismatch** (a very old CPU without AVX2). Ship the broadest-compatible CPU build by
  default; document the fallback build. The Phase 7 benchmark already warns on weak hardware.
- **Real artifacts still aren't in git** (correct — spec §0). These phases make obtaining them a
  *scripted, verified* step, but the repo green gate (`typecheck`/`test`/`build`) must keep passing
  with **zero** weights/binaries present (mocks fall back — Phase 10 decision). Tests mock the
  network.

## Per-phase ritual (mandatory)

Each phase isn't done until: `npm test` green, app still builds/launches, affected `docs/` updated,
`BUILD_STATE.md` updated (status, decisions, data contracts, next actions, risks), and a commit
references the phase (CLAUDE.md hard rule). The `fetch-*` and launcher logic lives in unit-tested
TS modules (`services/assets.ts`) with mocked I/O so the no-network guarantee in the test suite
holds.

---

## Sources (web research, June 2026)

- Hugging Face downloading / resumable + SHA-256 (HF CLI, HFDownloader, aria2):
  [BrightCoding 2025 guide](https://www.blog.brightcoding.dev/2025/12/12/the-ultimate-guide-to-downloading-hugging-face-models-datasets-like-a-pro-2025/),
  [HuggingFaceModelDownloader](https://github.com/bodaay/HuggingFaceModelDownloader),
  [HF GGUF docs](https://huggingface.co/docs/hub/en/gguf)
- llama.cpp prebuilt binary naming / which build to choose:
  [ggml-org/llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases),
  [llama-cpp.com download](https://llama-cpp.com/download/),
  [Qwen llama.cpp docs](https://qwen.readthedocs.io/en/latest/run_locally/llama.cpp.html)
- Docker for local LLMs — requirements/licensing/offline downsides:
  [Docker: Run LLMs locally](https://www.docker.com/blog/run-llms-locally/),
  [Docker Model Runner vs Ollama (2026)](https://www.glukhov.org/llm-hosting/comparisons/docker-model-runner-vs-ollama-comparison/)
- Portable Electron on USB — `%APPDATA%` portability pitfall & portable target:
  [electron-builder #6473 (true portable)](https://github.com/electron-userland/electron-builder/issues/6473),
  [Electron packaging docs](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)
