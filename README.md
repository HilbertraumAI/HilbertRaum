<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/src/renderer/public/brand/lockup-on-dark.svg">
  <img alt="HilbertRaum" src="apps/desktop/src/renderer/public/brand/lockup-on-light.svg" width="380">
</picture>

### Your private AI workspace — on a drive, fully offline

> Plug in a trusted drive, ask questions about your private documents, and keep everything local.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Platform: Windows · macOS · Linux](https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-informational.svg)](#what-you-need-diy)
[![Offline: no cloud · no telemetry](https://img.shields.io/badge/Offline-no%20cloud%20%C2%B7%20no%20telemetry-success.svg)](PRIVACY.md)
[![Built with: Electron · React · TypeScript](https://img.shields.io/badge/Built%20with-Electron%20%C2%B7%20React%20%C2%B7%20TypeScript-2ea44f.svg)](#for-developers)
[![Node ≥ 22.5](https://img.shields.io/badge/Node-%E2%89%A5%2022.5-339933.svg)](package.json)

</div>

---

HilbertRaum is an **open-source, offline AI workspace** for normal laptop users. It runs
small/medium open-weight language models **locally** — on your laptop's CPU (or GPU), reading
models from a portable USB-C SSD. Your prompts, documents, embeddings, and chat history never
leave your device.

- 🔒 **Private by design** — no cloud, no telemetry, no analytics, no prompt/document upload.
- 🧠 **Local models** — `llama.cpp` runtime with GGUF models (a curated open-weight catalog:
  Qwen3, Ministral, Gemma, Granite). The app benchmarks your machine and recommends one.
- 📄 **Document Q&A with citations** — import PDFs/Word/text, ask questions, get answers grounded
  in your files; hybrid (vector + keyword) retrieval with a reranker, scoped by **collections**.
- 🖼️ **Image understanding** — ask questions about a picture with a local vision model; the
  analysis history is encrypted at rest and deletable.
- 🎙️ **Audio & voice** — transcribe audio files (Whisper), dictate prompts, and OCR scanned pages.
- 🛠️ **Document tasks & skills** — summarize, translate, and compare documents; install reusable
  **skills** for structured extraction (bank statements, invoices, meeting protocols, redaction) —
  see the [skills overview](docs/skills-overview.md) for what each bundled skill can do.
- 🧳 **Portable & encrypted** — keep models + a password-encrypted workspace on an external drive;
  move between laptops.
- 🪟 **Cross-platform** — Windows-first, with macOS/Linux supported in the architecture.

> The MVP is **feature-complete**, plus GPU acceleration, retrieval-quality, UI-polish, and
> office-functionality waves. See **[`BUILD_STATE.md`](BUILD_STATE.md)** for live status.

## Table of contents

- [Status](#status)
- [Which path are you on?](#which-path-are-you-on)
- [What you need (DIY)](#what-you-need-diy)
- [Getting started (DIY / from source)](#getting-started-diy--from-source)
- [Supported models](#supported-models)
- [Two distribution paths](#two-distribution-paths)
- [Documentation](#documentation)
- [For developers](#for-developers)
- [Privacy & security](#privacy--security)
- [Contributing](#contributing)
- [License](#license)

## Status

Feature-complete, mock-first MVP: the app runs with **no model files and no network**, and real
`llama.cpp` inference engages automatically once the binaries + weights are present (step 2 below).
Remaining work is **manual release acceptance** (signed builds, a live USB demo) — tracked in
[`BUILD_STATE.md`](BUILD_STATE.md). Consciously-accepted gaps are listed in
[`docs/known-limitations.md`](docs/known-limitations.md).

## Which path are you on?

- **You bought a preconfigured drive** → you don't need this repo. Plug it in, double-click
  **Start HilbertRaum**, and follow **[`docs/user-guide.md`](docs/user-guide.md)**. Models are
  already on the drive.
- **You're setting it up yourself (DIY / from source)** → keep reading. You'll run the app, then
  download the models, then point the app at them.

## What you need (DIY)

- **A computer:** Windows (first-class), macOS, or Linux.
- **RAM decides which model the benchmark recommends** (the app benchmarks your machine and picks the
  best *fit*): ≤12 GB → Qwen3.5 4B · 16–20 GB → Qwen3.5 9B · 24 GB → Qwen3.6 27B (Q4) · ≥32 GB →
  Qwen3.6 27B (Q5); the MoEs stay opt-in. These are *recommended best-fit* tiers, **not** hard
  minimums — each model's actual floor is the lower **Min RAM** column in the model table below
  (e.g. Qwen3.5 9B already runs from 12 GB).
- **Disk space:** ~**3 GB** for the smallest *hand-built* setup (the 4B chat model + the embeddings
  model only). The one-command `--with-assets` quick-start fetches a larger **default set** (8B chat +
  embeddings + reranker + Whisper + the Qwen2.5-VL vision model + both sidecar runtimes + the OCR language files) at ~**10.4 GB** —
  size a drive for that if you use it; swapping the 8B chat model for a bigger one takes it to
  ~**14 GB** (14B) or ~**24 GB** (30B-A3B MoE). A **USB-3 SSD**
  is recommended for a portable drive.
- **To build from source:** **Node.js ≥ 22.5** (24 recommended; 22.15+ enables the
  `--use-system-ca` corporate-proxy workaround — run `scripts/setup-dev.{ps1,sh}`, which sets it
  automatically so `npm ci` doesn't hang behind a TLS-intercepting proxy) + **Git**.
- **The AI itself** = a **GGUF model file** *plus* the **`llama.cpp` `llama-server` binary**. Neither
  ships in this repo (licensing + size); the steps below download and verify them, or you add them by
  hand.

## Getting started (DIY / from source)

### 0. Download a prebuilt app (skip building from source)

Prebuilt packages are published on the **[Releases page](../../releases/latest)** — a portable
Windows `.exe`, a macOS (Apple Silicon) `.app.zip`, and a Linux AppImage, each with SHA-256
checksums. If no release is listed yet, build from source below — the result is the same app.

- **The download is the app only** — the AI models are fetched separately (step 2 below, or the
  in-app downloader on the AI Model screen).
- **Windows:** the build is unsigned for now — SmartScreen shows "Windows protected your PC";
  click **More info → Run anyway**.
- **macOS:** the `.app` is unsigned too — if Gatekeeper blocks the first launch, allow it under
  **System Settings → Privacy & Security → "Open Anyway"**. Keep the `.app` **zipped** when
  copying it onto an exFAT drive (the launcher extracts it).

Details for both flows live in [`docs/troubleshooting.md`](docs/troubleshooting.md). With a
prebuilt app you can skip step 1 and continue at step 2.

### 1. Run the app — no models needed yet

```bash
git clone <this-repo>
cd HilbertRaum
npm ci             # one-time; downloads the Electron binary (needs internet once)
npm run dev        # launches the app
```

With no model files present you can still explore the whole interface: open **AI Model** and click
**Try in demo mode** on a chat model (offered in developer mode, the dev default) — then chat,
document import, Q&A with citations, benchmark and privacy all work in the built-in demo mode.
**Demo answers are simulated placeholders** (they echo your input) — they are *not* real AI. Add a
real model (step 2) for genuine answers.

> The dependency install is the **only** step that touches the network. The app itself makes **no**
> network calls in its core path.

### 2. Download the models (the real AI)

The app reads model weights + the `llama-server` binary from a **drive root** — any folder (an
external drive, or a folder on your disk). Lay one out and download the AI in one command:

```powershell
# Windows
.\scripts\prepare-drive.ps1 -Target E:\ -WithAssets -AcceptLicense   # layout + download + verify
.\scripts\verify-models.ps1  -Target E:\ -Generate                   # record the real hashes
```
```bash
# macOS / Linux
scripts/prepare-drive.sh --target /Volumes/HILBERTRAUM --with-assets --accept-license
scripts/verify-models.sh  --target /Volumes/HILBERTRAUM --generate
```

**To keep setup fast, `-WithAssets` downloads a small but complete default set** — not the whole
catalog. It fetches the benchmark-winning mid-tier chat model (Ministral 3 8B, ~5 GB; on a ≤12 GB
machine you may prefer the smaller bundled Qwen3-4B — add it with `-AllModels` or from the AI Model
screen), the **embeddings** model (for document Q&A), the **reranker**, the **Whisper**
transcriber model, and the **vision** model (for image understanding), plus **both sidecar
runtimes** (`llama.cpp` for chat/embeddings, `whisper.cpp` for audio) and the **OCR language
files** (`deu`/`eng`, ~4 MB, for scanned-PDF and photo text recognition). That's enough to chat, ask
questions about your documents, get higher-quality retrieval, transcribe audio, understand
images, and OCR scanned documents out of the box. You download any **other** models (larger chat
models) **from inside the app** later, on demand. To provision
*every* model up front instead, add `-AllModels` (Windows) / `--all-models` (macOS/Linux). The
sidecar runtimes and OCR files are fetched either way.

Whatever it fetches, it **SHA-256-verifies** against the manifest and copies the manifests/config
onto the drive. Downloads **resume** if interrupted and re-running **skips** what's already there.
You can also fetch piecemeal (`fetch-models` / `fetch-runtime`, with `--only <id>` for a single
model) or drop the files into `models/` and `runtime/llama.cpp/<os>/` **by hand** — see
**[`docs/packaging.md`](docs/packaging.md)**.

> 🎙️ The whisper.cpp runtime ships **prebuilt for Windows only**; on a macOS/Linux build host
> `-WithAssets` skips it with a note (build it from source — see **[`docs/packaging.md`](docs/packaging.md)**).

> ✅ **`runtime-sources.yaml` is pinned to a real release** (`llama.cpp` **b9849** — bumped from
> b9585 on 2026-07-01 as the Qwen3.5 compatibility gate; real per-OS URLs + SHA-256 checksums from
> the official GitHub Releases API `digest` metadata) — `fetch-runtime` downloads, verifies,
> extracts (zip and tar.gz), and flattens the binaries for all three OSes from any host. Model
> weight URLs are real Hugging Face links, and the bundled manifests carry **real pinned
> SHA-256 hashes** (captured from verified downloads with `verify-models --generate`), so
> `fetch-models` checks every weight against them. To bump the runtime later, see
> **[`docs/model-policy.md`](docs/model-policy.md)**.

### 3. Point the app at your models

The app uses whatever folder **`HILBERTRAUM_DRIVE_ROOT`** names (a prepared folder contains
`config/drive.json`). On a preconfigured drive the launcher sets this automatically; from source you
set it yourself, then launch:

```powershell
$env:HILBERTRAUM_DRIVE_ROOT = 'E:\'; npm run dev    # Windows
```
```bash
HILBERTRAUM_DRIVE_ROOT=/Volumes/HILBERTRAUM npm run dev    # macOS / Linux
```

Open **AI Model**, press **Use this model** on the recommended model, and chat for real. To ship a portable
build instead of `npm run dev`, see `npm run package:win` in **[`docs/packaging.md`](docs/packaging.md)**.

Run tests / type-check: `npm test`, `npm run typecheck`.

## Supported models

Downloaded by the scripts above (or add your own via a manifest). Weights are **never** in the repo;
the per-model details live in [`model-manifests/`](model-manifests) and the full schema + license
policy in **[`docs/model-policy.md`](docs/model-policy.md)**.

**The default set** (`-WithAssets`) is enough for everyday use: a chat model + **embeddings**
(document Q&A) + **reranker** (retrieval quality) + **Whisper** (audio). The benchmark
auto-recommends the newest-generation Qwen chat model that fits your RAM: **≤12 GB → Qwen3.5 4B,
16–20 GB → Qwen3.5 9B, 24 GB → Qwen3.6 27B (Q4), ≥32 GB → Qwen3.6 27B (Q5)** (best-*fit* tiers;
the table's **Min RAM** column is each model's lower hard floor — except the two fast-tier entries,
which deliberately carry the 4B's tier-aligned line rather than a measured floor so they cannot
hijack the ≤12 GB recommendation). The **MoEs** (Qwen3 30B-A3B,
Qwen3.5 35B-A3B) are opt-in (≈30B quality at ≈3B *active* params/token → near-small-model CPU
speed **if** the ~18-22 GB weight fits in RAM).

### Chat models

| Model | Note | Size | Min RAM | License |
|---|---|---|---|---|
| Qwen3 4B Instruct Q4 | Preconfigured-drive bundled default & weak-laptop fallback (smallest *ranked* model; keeps **Deep** answer mode). The DIY `--with-assets` default-set chat model is Ministral 3 8B (below) | ~2.7 GB | 8 GB | Apache-2.0 |
| Qwen3 4B Instruct 2507 Q4 | Better 4B quality (no Deep) | ~2.5 GB | 8 GB | Apache-2.0 |
| Qwen3.5 4B (UD-Q4_K_XL) | **Recommended ≤12 GB**: newest-generation 4B | ~2.9 GB | 8 GB | Apache-2.0 |
| Gemma 4 E2B Instruct QAT Q4_0 | Gemma 4 QAT wave low-end challenger (selectable; not auto-recommended) | ~3.3 GB | 8 GB | Apache-2.0 |
| Qwen3.5 0.8B Q6_K | **Fast tier — selectable, never auto-recommended.** Smallest runnable chat model and the fastest CPU decode in the catalog. The 2026-07 grounded-QA eval ([`docs/model-benchmarks.md`](docs/model-benchmarks.md) §9) leaves it the *surviving* fast-tier candidate — the honest floor (better F1 and unanswerable-question discipline than the 2B below); owner ratification + the in-app runtime smoke are still pending | ~0.6 GB | 8 GB | Apache-2.0 |
| Qwen3.5 2B (UD-Q4_K_XL) | **Fast tier — FAILED its evaluation bar.** The same eval scored it below the 0.8B on F1 with the worst unanswerable-question discipline of the 13 models tested, so it should not be recommended anywhere; downloadable for completeness only | ~1.3 GB | 8 GB | Apache-2.0 |
| Qwen3 8B Instruct Q4 | 12 GB+ laptops | ~5.0 GB | 12 GB | Apache-2.0 |
| Ministral 3 8B Instruct (2512) Q4 | Phase-29 8B benchmark winner (selectable; the 16–20 GB pick is now Qwen3.5 9B) | ~5.2 GB | 12 GB | Apache-2.0 |
| Qwen3.5 9B (UD-Q4_K_XL) | **Recommended 16–20 GB**: newest-generation 9B | ~6.0 GB | 12 GB | Apache-2.0 |
| Granite 4.1 8B Q4 | Challenger (selectable, not auto-recommended) | ~5.3 GB | 12 GB | Apache-2.0 |
| Gemma 4 E4B Instruct QAT Q4_0 | Gemma 4 QAT wave 8B-tier challenger (selectable; not auto-recommended) | ~5.2 GB | 12 GB | Apache-2.0 |
| Gemma 4 12B Instruct QAT Q4_0 | Phase-29 12–14B benchmark winner; has **Deep** (selectable; the ≥24 GB pick is now Qwen3.6 27B) | ~7.0 GB | 14 GB | Apache-2.0 |
| Qwen3 14B Instruct Q4 | Dense, 32 GB+ | ~9.3 GB | 14 GB | Apache-2.0 |
| Gemma 4 26B-A4B Instruct QAT Q4_0 | Gemma 4 QAT wave MoE (~3.8B active; selectable, not auto-recommended) | ~14.4 GB | 20 GB | Apache-2.0 |
| Qwen3.6 27B Q4_K_M | **Recommended 24 GB**: newest generation, top scorer of the 2026-07 quality eval | ~16.8 GB | 20 GB | Apache-2.0 |
| Qwen3.6 27B Q5_K_M | **Recommended ≥32 GB**: the same top scorer at a richer quant | ~19.5 GB | 24 GB | Apache-2.0 |
| Qwen3 30B-A3B (MoE) Q4 | ≈30B quality, ≈3B speed (opt-in) | ~18.6 GB | 24 GB | Apache-2.0 |
| Qwen3.5 27B (UD-Q4_K_XL) | Qwen3.5 wave dense challenger (selectable; not auto-recommended) | ~17.6 GB | 24 GB | Apache-2.0 |
| Gemma 4 31B Instruct QAT Q4_0 | Gemma 4 QAT wave dense ceiling (opt-in, selectable; slow on CPU) | ~17.7 GB | 24 GB | Apache-2.0 |
| Qwen3.5 35B-A3B (UD-Q4_K_XL) | Qwen3.5 wave MoE (~3B active; opt-in, selectable) | ~22.2 GB | 24 GB | Apache-2.0 |

### Supporting models (non-chat)

| Model | Role | What it powers | Min RAM | License |
|---|---|---|---|---|
| Multilingual E5 Small (F16) | Embeddings | Document search / RAG (**required** for Q&A) | 4 GB | MIT |
| BGE Reranker v2 M3 (F16) | Reranker | Higher-quality retrieval ordering | 6 GB | Apache-2.0 |
| Whisper Small (multilingual) | Transcriber | Audio-file transcription + dictation | 4 GB | MIT |
| Qwen2.5-VL 3B Instruct Q4 | Vision | Image understanding (in the `--with-assets` default set; else in-app download) | 12 GB | Apache-2.0 |
| TranslateGemma 12B (Q4_K_M) | Translation | Document & text translation (opt-in; in-app download behind a license prompt) | 13 GB | Gemma Terms |

Document Q&A needs the **embeddings** model; chat needs **one** of the chat models. Bigger **dense**
models are smarter but slower on CPU — pick by your RAM. Benchmark methodology and measured numbers
are in **[`docs/model-benchmarks.md`](docs/model-benchmarks.md)**.

## Two distribution paths

- **Open-source DIY toolkit** — clone this repo, prepare your own drive, download supported models
  (the path above).
- **Preconfigured drive** *(commercial)* — a prepared SSD with tested hardware, a signed/notarized
  app, preloaded + verified models, and double-click onboarding (built by
  `scripts/build-commercial-drive.*`; see [`docs/packaging.md`](docs/packaging.md)). The
  software core stays open source.

## Documentation

| Doc | What's inside |
|---|---|
| [`docs/product-vision.md`](docs/product-vision.md) | Product intent: thesis, target user, commercial model, positioning guardrails, scope, roadmap |
| [`docs/user-guide.md`](docs/user-guide.md) | End-user walkthrough of every screen and feature |
| [`docs/architecture.md`](docs/architecture.md) | System design, services, IPC, runtimes, design records |
| [`docs/rag-design.md`](docs/rag-design.md) | Retrieval pipeline: ingestion, chunking, hybrid search, rerank |
| [`docs/security-model.md`](docs/security-model.md) | Threat model, encrypted vault, offline guard, audit log |
| [`docs/design-guidelines.md`](docs/design-guidelines.md) | Design system: tokens, components, UI/UX design records |
| [`docs/skills-overview.md`](docs/skills-overview.md) | The bundled skills at a glance — what each can do; reviewed on every skill change |
| [`docs/model-policy.md`](docs/model-policy.md) | Manifest schema, roles, license policy, runtime pinning |
| [`docs/model-benchmarks.md`](docs/model-benchmarks.md) | Measured **model** speed / RAM / quality + the offline harness (not the hardware probe) |
| [`docs/benchmark.md`](docs/benchmark.md) | In-app **hardware** benchmark & model recommendation (the machine-capability probe) |
| [`docs/drive-layout.md`](docs/drive-layout.md) | On-drive directory layout and how the app finds its data |
| [`docs/packaging.md`](docs/packaging.md) | Preparing a drive, fetch scripts, portable builds |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Common problems and fixes |
| [`docs/known-limitations.md`](docs/known-limitations.md) | Consciously-accepted gaps |
| [`docs/data-contracts.md`](docs/data-contracts.md) | Shared cross-module data contracts (IPC surface, DB schema, streaming, …) |
| [`docs/build-log.md`](docs/build-log.md) | Archive of retired `BUILD_STATE.md` entries (frozen; grep for old citations) |
| [`BUILD_STATE.md`](BUILD_STATE.md) | Live build state — read first when contributing |
| [`CHANGELOG.md`](CHANGELOG.md) | Release/version history (pre-1.0; see also `BUILD_STATE.md`) |

## For developers

A **single Electron app** in an npm-workspaces monorepo (`apps/desktop`), built with `electron-vite`
(Electron + React + TypeScript). Storage is the built-in `node:sqlite`; model runtimes are external
sidecars (`llama.cpp`, `whisper.cpp`) so they stay swappable behind clean service interfaces.

```text
HilbertRaum/
├─ apps/desktop/        # the Electron app (main / preload / renderer + tests)
│  └─ src/main/services # chat, rag, embeddings, reranker, vision, ocr, skills, …
├─ docs/                # architecture, rag, security, packaging, … (see above)
├─ model-manifests/     # per-model YAML (chat, embeddings, reranker, transcriber, translation, vision)
├─ app-skills/          # bundled skills (bank-statement, invoice, redaction, document-edit + Professional Documents: meeting-minutes, contract-brief, deadlines, what-changed, share-safe)
├─ scripts/             # prepare-drive / fetch-models / fetch-runtime / verify-models / …
├─ launchers/           # double-click launcher templates for a prepared drive
└─ eval/                # retrieval/quality evaluation fixtures
```

```bash
npm ci             # install (dev-time only; needs internet once for the Electron binary)
#   npm ci installs EXACTLY what package-lock.json pins and never rewrites it (issue #49) —
#   use it after every pull; plain `npm install` is only for deliberate dependency changes
#   (with the pinned npm — see `packageManager` in package.json).
npm run dev        # launch the app
npm run build      # production build
npm test           # unit + integration tests (whole suite)
npm run typecheck  # TypeScript checking
npm run package:win # portable Windows .exe (electron-builder)
# Faster iteration (from apps/desktop/): npx vitest run <file> · npx vitest -t "<name>" · npm run test:watch
```

New here? Read [`BUILD_STATE.md`](BUILD_STATE.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) first —
they cover the hard rules and the mandatory per-phase ritual (tests green, docs updated,
`BUILD_STATE.md` updated).

## Privacy & security

Nothing you type or import is sent anywhere. The workspace can be **password-encrypted at rest**
(AES-256-GCM, Argon2id key derivation), an **offline guard** logs (never blocks) any attempt to
reach a remote host while offline — local `127.0.0.1`/`localhost` connections are exempt — and a
local audit log records activity **for you** (ids/counts only — never content).
See [`PRIVACY.md`](PRIVACY.md) and [`docs/security-model.md`](docs/security-model.md); report
vulnerabilities per [`SECURITY.md`](SECURITY.md).

## Contributing

Contributions are welcome — please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the ground rules
(no cloud/telemetry, offline-first, never commit weights/user data) and the workflow, and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community expectations. Work one vertical slice at a
time, add tests, keep `npm run typecheck` clean, and update the docs + `BUILD_STATE.md`.

## License

[GPL-3.0-or-later](LICENSE) for the software core. Model weights are **not** included and carry their
own licenses (see [`docs/model-policy.md`](docs/model-policy.md)). Third-party notices for the npm
packages bundled into packaged builds: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

**Our promise: the HilbertRaum core is free software and will stay under GPL-3.0-or-later — every
version we publish here, forever.** To fund its open development, we additionally offer the same
software under **commercial licenses** (dual licensing) — for example for tailor-made solutions for
small businesses, or for embedding in other products without GPL obligations. That's also why
contributions require a lightweight [Contributor License Agreement](.github/CLA.md); the reasoning
is spelled out in [CONTRIBUTING.md](CONTRIBUTING.md#license-and-cla). Interested in a commercial
license? Open an issue or contact the maintainers.

"HilbertRaum" and the HilbertRaum logo are trademarks — the GPL covers the code, not the name.
Forks and unofficial kits must use their own branding; see [TRADEMARKS.md](TRADEMARKS.md).
