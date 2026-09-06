<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/src/renderer/public/brand/lockup-on-dark.svg">
  <img alt="HilbertRaum" src="apps/desktop/src/renderer/public/brand/lockup-on-light.svg" width="380">
</picture>

### Your private AI workspace, fully offline

> Chat with a local AI, ask questions about your private documents, and keep everything on your own computer.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Platform: Windows · macOS · Linux](https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-informational.svg)](#what-you-need)
[![Offline: no cloud · no telemetry](https://img.shields.io/badge/Offline-no%20cloud%20%C2%B7%20no%20telemetry-success.svg)](PRIVACY.md)
[![Built with: Electron · React · TypeScript](https://img.shields.io/badge/Built%20with-Electron%20%C2%B7%20React%20%C2%B7%20TypeScript-2ea44f.svg)](#for-developers)
[![Node ≥ 22.12](https://img.shields.io/badge/Node-%E2%89%A5%2022.12-339933.svg)](package.json)

**Quick start:** [download the latest release](../../releases/latest), install it, and the app walks you through adding the AI engine and a model.

</div>

---

**HilbertRaum is a private AI workspace that runs locally on your computer and can operate entirely offline.** Chat with a local AI, ask questions about your documents, and keep your data under your control. There is no cloud fallback, no web search, and no telemetry. Your prompts, documents, embeddings, and chat history stay on local storage.

**The workspace is encrypted and portable.** The app, models, and data can all live on a hard drive or USB drive, allowing you to move the entire setup between machines.

**HilbertRaum is open source and designed to run on a wide range of hardware,** from CPU-only systems to single-GPU and unified-memory machines. The model catalog is intentionally small: we test each model for quality, speed, and hardware compatibility. HilbertRaum then selects an appropriate model for your machine, so you don't need to compare models or tune technical settings.

- 🔒 **Private by design.** No cloud, no telemetry, no analytics. Nothing you type or import is uploaded.
- 🧳 **Portable and encrypted.** Keep models and a password-encrypted workspace on an external drive
  and move between computers.
- 🧠 **Local models.** A `llama.cpp` runtime with GGUF models from a curated open-weight catalog
  (Qwen3, Ministral, Gemma, Granite). The app benchmarks your machine and recommends one.
- 📄 **Document Q&A with citations.** Import PDFs, Word files, or text, ask questions, and get
  answers grounded in your files. Retrieval combines vector and keyword search with a reranker
  and can be scoped to your library, a project, a section, specific documents, or the files
  attached to a chat.
- 📚 **Knowledge packs (optional).** Register ZIM archives — such as an offline Wikipedia — as
  per-chat sources searched alongside your documents. Needs the kiwix-tools binaries placed
  on the drive; the app downloads nothing.
- 🖼️ **Image understanding.** Ask questions about a picture with a local vision model. The analysis
  history is encrypted at rest and can be deleted.
- 🎙️ **Audio and voice.** Transcribe audio files with Whisper, dictate prompts, and OCR scanned pages.
- 🌐 **Translation.** A dedicated screen for text and whole documents (local TranslateGemma sidecar,
  51 languages). Translated documents land back in your library.
- ✅ **Evidence review.** Turn a document answer into a reviewable record: every statement is checked
  against its frozen source snippets, decisions and notes are saved, and the result exports as an
  HTML or PDF evidence pack.
- 🛠️ **Document tasks and skills.** Summarize, translate, and compare documents, or install reusable
  skills for structured extraction (bank statements, invoices, meeting protocols, redaction). The
  [skills overview](docs/skills-overview.md) describes each bundled skill.
- 🪟 **Cross-platform.** Runs on Windows, macOS, and Linux.
- 🔌 **Local API (opt-in).** Other programs on the same computer can use your running model through
  an OpenAI-compatible loopback endpoint: point any client at `http://127.0.0.1:4980/v1`. It is
  off by default, never touches the internet, exposes only completions (no documents, no
  conversations), and keeps no record of what was asked. See [`docs/local-api.md`](docs/local-api.md).

## Table of contents

- [Status](#status)
- [Which path are you on?](#which-path-are-you-on)
- [What you need](#what-you-need)
- [Getting started (DIY / from source)](#getting-started-diy--from-source)
- [Supported models](#supported-models)
- [Two distribution paths](#two-distribution-paths)
- [Documentation](#documentation)
- [For developers](#for-developers)
- [Privacy & security](#privacy--security)
- [Contributing](#contributing)
- [License](#license)

## Status

The app is feature-complete. You can explore the whole interface without downloading a model,
and real AI answers start as soon as you add one (step 2 below). What remains before the first
polished release is manual release testing: signed installers and a live demo run.
[`BUILD_STATE.md`](BUILD_STATE.md) tracks the details, and
[`docs/known-limitations.md`](docs/known-limitations.md) lists the gaps we have accepted for now.

## Which path are you on?

- **You set it up yourself (free, open source).** Keep reading: you install the app, download
  the models, and point the app at them.
- **You want it ready-made.** We are preparing the HilbertRaum AI Kit, a preconfigured drive with
  tested hardware and preloaded models: plug it in, double-click **Start HilbertRaum**, and follow
  the [user guide](docs/user-guide.md). Join the waitlist at [hilbertraum.ai](https://hilbertraum.ai).

## What you need

- **A computer** running Windows, macOS, or Linux, with at least **8 GB of RAM**.
- **Memory decides which model you get.** The app detects your RAM and graphics memory (VRAM)
  automatically, benchmarks your machine, and recommends the model that fits best. The
  recommended tiers, based on our benchmarks:

  | RAM / VRAM | Recommended model |
  |---|---|
  | 8-11 GB | Qwen3.5 4B |
  | 12-15 GB | Gemma 4 E2B |
  | 16-23 GB | Qwen3.5 9B |
  | 24 GB | Qwen3.8 27B (UD-Q4_K_M) |
  | 32 GB and up | Qwen3.8 27B (UD-Q5_K_M) |

  These are best-fit recommendations, not hard minimums. Each model's actual floor is the
  **Min RAM** column in the [model table](#supported-models) below; Qwen3.5 9B, for example,
  already runs from 12 GB. The MoE models stay opt-in.
- **Disk space:** about 3 GB for the smallest hand-built setup (the 4B chat model plus the
  embeddings model). The one-command `--with-assets` quick start fetches a larger default set
  (8B chat, embeddings, reranker, Whisper, the Qwen2.5-VL vision model, both sidecar runtimes,
  and the OCR language files) at about 10.4 GB; size a drive for that if you use it. Swapping
  the 8B chat model for a bigger one takes it to roughly 14 GB (14B) or 24 GB (30B-A3B MoE).
  For a portable drive, a USB-3 SSD is recommended.
- **To build from source:** Node.js 22.12 or newer (24 recommended; 22.15+ enables the
  `--use-system-ca` corporate-proxy workaround, and `scripts/setup-dev.{ps1,sh}` sets it
  automatically so `npm ci` doesn't hang behind a TLS-intercepting proxy) plus Git.
- **The AI itself** is a GGUF model file plus the `llama.cpp` `llama-server` binary. Neither
  ships in this repo (licensing and size); the steps below download and verify them, or you add
  them by hand.

## Getting started (DIY / from source)

### 0. Download a prebuilt app (skip building from source)

Prebuilt packages are published on the [Releases page](../../releases/latest): a portable
Windows `.exe`, a macOS (Apple Silicon) `.app.zip`, and a Linux AppImage, each with SHA-256
checksums. If no release is listed yet, build from source below; the result is the same app.

- The download is the app only. A working chat needs two more downloads, both offered on the
  **AI Model** screen inside the app: the AI engine (the `llama.cpp` runtime; the screen shows
  an install banner until it is present, and without it started models run in demo mode with
  simulated answers) and an AI model of your choice. Every download asks first and is
  SHA-256-verified. Repo users can instead provision everything up front with step 2 below.
- **Windows:** the build is unsigned for now, so SmartScreen shows "Windows protected your PC".
  Click **More info → Run anyway**.
- **macOS:** the `.app` is unsigned too. If Gatekeeper blocks the first launch, allow it under
  **System Settings → Privacy & Security → "Open Anyway"**. Keep the `.app` zipped when copying
  it onto an exFAT drive (the launcher extracts it).

Details for both flows live in [`docs/troubleshooting.md`](docs/troubleshooting.md). With a
prebuilt app and no repo, the in-app installs above are all you need; with the repo, skip
step 1 and continue at step 2 to provision a drive up front.

### 1. Run the app (no models needed yet)

```bash
git clone <this-repo>
cd HilbertRaum
npm ci             # one-time; downloads the Electron binary (needs internet once)
npm run dev        # launches the app
```

With no model files present you can still explore the whole interface: open **AI Model** and
click **Try in demo mode** on a chat model (offered in developer mode, the dev default). Chat,
document import, Q&A with citations, the benchmark, and the privacy screen all work in demo
mode. Demo answers are simulated placeholders that echo your input; they are not real AI. Add
a real model (step 2) for genuine answers.

> The dependency install is the only step that touches the network. The app itself makes no
> network calls in its core path.

### 2. Download the models (the real AI)

The app reads model weights and the `llama-server` binary from a drive root, which is any
folder: an external drive, or a folder on your disk. Lay one out and download the AI in one
command:

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

To keep setup fast, `-WithAssets` downloads a small but complete default set, not the whole
catalog. It fetches the benchmark-winning mid-tier chat model (Ministral 3 8B, ~5 GB; on a
machine with 12 GB or less you may prefer the smaller bundled Qwen3-4B, which you add with
`-AllModels` or from the AI Model screen), the embeddings model (for document Q&A), the
reranker, the Whisper transcriber model, and the vision model (for image understanding), plus
both sidecar runtimes (`llama.cpp` for chat and embeddings, `whisper.cpp` for audio) and the
OCR language files (`deu`/`eng`, ~4 MB, for scanned-PDF and photo text recognition). That is
enough to chat, ask questions about your documents, get higher-quality retrieval, transcribe
audio, understand images, and OCR scanned documents out of the box. Any other models (larger
chat models) can be downloaded from inside the app later, on demand. To provision every model
up front instead, add `-AllModels` (Windows) / `--all-models` (macOS/Linux). The sidecar
runtimes and OCR files are fetched either way.

Whatever it fetches, the script verifies against the manifest via SHA-256 and copies the
manifests and config onto the drive. Downloads resume if interrupted, and re-running skips
what is already there. You can also fetch piecemeal (`fetch-models` / `fetch-runtime`, with
`--only <id>` for a single model) or drop the files into `models/` and
`runtime/llama.cpp/<os>/` by hand; see [`docs/packaging.md`](docs/packaging.md).

> The whisper.cpp runtime ships prebuilt for Windows only. On a macOS/Linux build host,
> `-WithAssets` skips it with a note; build it from source as described in
> [`docs/packaging.md`](docs/packaging.md).

> `runtime-sources.yaml` is pinned to a real `llama.cpp` release (b9849, bumped from b9585 on
> 2026-07-01 as the Qwen3.5 compatibility gate) with real per-OS URLs and SHA-256 checksums
> from the official GitHub Releases API digest metadata. `fetch-runtime` downloads, verifies,
> extracts (zip and tar.gz), and flattens the binaries for all three OSes from any host. Model
> weight URLs are real Hugging Face links, and the bundled manifests carry real pinned SHA-256
> hashes (captured from verified downloads with `verify-models --generate`), so `fetch-models`
> checks every weight against them. To bump the runtime later, see
> [`docs/model-policy.md`](docs/model-policy.md).

### 3. Point the app at your models

The app uses whatever folder `HILBERTRAUM_DRIVE_ROOT` names (a prepared folder contains
`config/drive.json`). On a preconfigured drive the launcher sets this automatically; from
source you set it yourself, then launch:

```powershell
$env:HILBERTRAUM_DRIVE_ROOT = 'E:\'; npm run dev    # Windows
```
```bash
HILBERTRAUM_DRIVE_ROOT=/Volumes/HILBERTRAUM npm run dev    # macOS / Linux
```

Open **AI Model**, press **Use this model** on the recommended model, and chat for real. To
ship a portable build instead of `npm run dev`, see `npm run package:win` in
[`docs/packaging.md`](docs/packaging.md).

Run tests / type-check: `npm test`, `npm run typecheck`.

## Supported models

The scripts above download these (or add your own via a manifest). Weights are never in the
repo; the per-model details live in [`model-manifests/`](model-manifests) and the full schema
and license policy in [`docs/model-policy.md`](docs/model-policy.md).

The default set (`-WithAssets`) is enough for everyday use: a chat model plus embeddings
(document Q&A), reranker (retrieval quality), and Whisper (audio). The benchmark
auto-recommends the newest-generation chat model that fits your memory, following the tier
table in [What you need](#what-you-need); the **Min RAM** column below is each model's lower
hard floor. The MoE models (Qwen3 30B-A3B, Qwen3.5 35B-A3B) are opt-in: roughly 30B quality at
roughly 3B active parameters per token, which means near-small-model CPU speed if the 18-22 GB
of weights fits in RAM.

### Chat models

| Model | Note | Size | Min RAM | License |
|---|---|---|---|---|
| Qwen3 4B Instruct Q4 | Bundled default on the preconfigured drive and the weak-laptop fallback; smallest ranked model that keeps the **Deep** answer mode | ~2.7 GB | 8 GB | Apache-2.0 |
| Qwen3 4B Instruct 2507 Q4 | Better 4B quality (no Deep) | ~2.5 GB | 8 GB | Apache-2.0 |
| Qwen3.5 4B (UD-Q4_K_XL) | **Recommended below 12 GB**: newest-generation 4B | ~2.9 GB | 8 GB | Apache-2.0 |
| Gemma 4 E2B Instruct QAT Q4_0 | **Recommended for 12-15 GB**: fastest small-tier decode we measured; also where a slow 16-23 GB machine's recommendation steps down to | ~3.3 GB | 8 GB | Apache-2.0 |
| Qwen3.5 0.8B Q6_K | Fast tier, selectable but never auto-recommended. Smallest runnable chat model and the fastest CPU decode in the catalog; the surviving fast-tier candidate of our grounded-QA eval ([`docs/model-benchmarks.md`](docs/model-benchmarks.md) §9), with better F1 and unanswerable-question discipline than the 2B below | ~0.6 GB | 8 GB | Apache-2.0 |
| Qwen3.5 2B (UD-Q4_K_XL) | Fast tier; failed its evaluation bar (scored below the 0.8B on F1 with the worst unanswerable-question discipline of the 13 models tested). Downloadable for completeness only | ~1.3 GB | 8 GB | Apache-2.0 |
| Qwen3 8B Instruct Q4 | For laptops with 12 GB and more | ~5.0 GB | 12 GB | Apache-2.0 |
| Ministral 3 8B Instruct (2512) Q4 | 8B benchmark winner and the DIY `--with-assets` default chat model (selectable; the 16-23 GB pick is Qwen3.5 9B) | ~5.2 GB | 12 GB | Apache-2.0 |
| Qwen3.5 9B (UD-Q4_K_XL) | **Recommended for 16-23 GB**: newest-generation 9B | ~6.0 GB | 12 GB | Apache-2.0 |
| Granite 4.1 8B Q4 | Challenger (selectable, not auto-recommended) | ~5.3 GB | 12 GB | Apache-2.0 |
| Gemma 4 E4B Instruct QAT Q4_0 | 8B-tier challenger (selectable, not auto-recommended) | ~5.2 GB | 12 GB | Apache-2.0 |
| Gemma 4 12B Instruct QAT Q4_0 | 12-14B benchmark winner; has **Deep** (selectable; the 24 GB pick is Qwen3.8 27B) | ~7.0 GB | 14 GB | Apache-2.0 |
| Qwen3 14B Instruct Q4 | Dense, for 32 GB and more | ~9.3 GB | 14 GB | Apache-2.0 |
| Gemma 4 26B-A4B Instruct QAT Q4_0 | MoE (~3.8B active): the 24 GB tier's ranked runner-up at about four times the pick's speed, never the auto-pick | ~14.4 GB | 20 GB | Apache-2.0 |
| Qwen3.6 27B Q4_K_M | Former 24 GB pick; still ranked and selectable | ~16.8 GB | 20 GB | Apache-2.0 |
| Qwen3.6 27B Q5_K_M | Former 32 GB pick; still holds the all-time top score of our grounded-QA eval | ~19.5 GB | 24 GB | Apache-2.0 |
| Qwen3.8 27B UD-Q4_K_M | **Recommended for 24 GB**: newest generation, zero hallucinations in our quality eval. Decodes about 19 % slower than the withdrawn static Q4_K_M it replaces; measured and accepted | ~16.5 GB | 21 GB | Apache-2.0 |
| Qwen3.8 27B UD-Q5_K_M | **Recommended for 32 GB and up**: the same zero-hallucination profile at a richer quant; reproduces the withdrawn Q5_K_M's envelope (4 % slower decode, same VRAM) | ~19.8 GB | 23 GB | Apache-2.0 |
| Qwen3.8 27B UD-Q6_K | Quality ceiling for 24 GB GPUs (selectable, never auto-recommended; fully fits a 24 GB card at 8k context with a 21.8 GiB peak) | ~22.0 GB | 26 GB | Apache-2.0 |
| Qwen3.8 27B Q4_K_M · Q5_K_M · Q6_K (static) | Upstream deleted these three files on 2026-08-20 ([issue #196](https://github.com/HilbertraumAI/HilbertRaum/issues/196)). Kept so a drive that already has one keeps working: it still verifies and runs, but it can no longer be downloaded, and the app says so instead of offering a Download button. Succeeded by the three UD rows above | ~17.1 / 19.8 / 22.9 GB | 21 / 23 / 26 GB | Apache-2.0 |
| Qwen3 30B-A3B (MoE) Q4 | Roughly 30B quality at roughly 3B speed (opt-in) | ~18.6 GB | 24 GB | Apache-2.0 |
| Qwen3.5 27B (UD-Q4_K_XL) | Dense challenger (selectable, not auto-recommended) | ~17.6 GB | 24 GB | Apache-2.0 |
| Gemma 4 31B Instruct QAT Q4_0 | Dense ceiling (opt-in, selectable; slow on CPU) | ~17.7 GB | 24 GB | Apache-2.0 |
| Qwen3.5 35B-A3B (UD-Q4_K_XL) | MoE (~3B active): rank 1 in our eval and the ranked speed alternative for 32 GB and up, never the auto-pick | ~22.2 GB | 24 GB | Apache-2.0 |

### Supporting models (non-chat)

| Model | Role | What it powers | Min RAM | License |
|---|---|---|---|---|
| Multilingual E5 Small (F16) | Embeddings | Document search / RAG (**required** for Q&A) | 4 GB | MIT |
| BGE Reranker v2 M3 (F16) | Reranker | Higher-quality retrieval ordering | 6 GB | Apache-2.0 |
| Whisper Small (multilingual) | Transcriber | Audio-file transcription and dictation | 4 GB | MIT |
| Qwen2.5-VL 3B Instruct Q4 | Vision | Image understanding (in the `--with-assets` default set; otherwise an in-app download) | 12 GB | Apache-2.0 |
| TranslateGemma 12B (Q4_K_M) | Translation | Document and text translation (opt-in; in-app download behind a license prompt) | 13 GB | Gemma Terms |

Document Q&A needs the embeddings model; chat needs one of the chat models. Bigger dense
models are smarter but slower on CPU, so pick by your RAM. Benchmark methodology and measured
numbers are in [`docs/model-benchmarks.md`](docs/model-benchmarks.md).

## Two distribution paths

- **Open-source DIY toolkit.** Clone this repo, prepare your own drive, and download supported
  models (the path above).
- **HilbertRaum AI Kit** (commercial). A preconfigured drive with tested hardware, a signed and
  notarized app, preloaded and verified models, and double-click onboarding. Currently in
  preparation; join the waitlist at [hilbertraum.ai](https://hilbertraum.ai). It is built by
  `scripts/build-commercial-drive.*` (see [`docs/packaging.md`](docs/packaging.md)), and the
  software core stays open source.

## Documentation

| Doc | What's inside |
|---|---|
| [`docs/product-vision.md`](docs/product-vision.md) | Product intent: thesis, target user, commercial model, positioning guardrails, scope, roadmap |
| [`docs/user-guide.md`](docs/user-guide.md) | End-user walkthrough of every screen and feature |
| [`docs/architecture.md`](docs/architecture.md) | System design, services, IPC, runtimes, design records |
| [`docs/rag-design.md`](docs/rag-design.md) | Retrieval pipeline: ingestion, chunking, hybrid search, rerank |
| [`docs/security-model.md`](docs/security-model.md) | Threat model, encrypted vault, offline guard, audit log |
| [`docs/local-api.md`](docs/local-api.md) | The opt-in local API: tutorial, client examples, the full HTTP contract, security and privacy posture |
| [`docs/design-guidelines.md`](docs/design-guidelines.md) | Design system: tokens, components, UI/UX design records |
| [`docs/skills-overview.md`](docs/skills-overview.md) | The bundled skills at a glance; reviewed on every skill change |
| [`docs/model-policy.md`](docs/model-policy.md) | Manifest schema, roles, license policy, runtime pinning |
| [`docs/model-benchmarks.md`](docs/model-benchmarks.md) | Measured model speed / RAM / quality plus the offline harness (not the hardware probe) |
| [`docs/benchmark.md`](docs/benchmark.md) | In-app hardware benchmark and model recommendation (the machine-capability probe) |
| [`docs/drive-layout.md`](docs/drive-layout.md) | On-drive directory layout and how the app finds its data |
| [`docs/packaging.md`](docs/packaging.md) | Preparing a drive, fetch scripts, portable builds |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Common problems and fixes |
| [`docs/known-limitations.md`](docs/known-limitations.md) | Consciously accepted gaps |
| [`docs/data-contracts.md`](docs/data-contracts.md) | Shared cross-module data contracts (IPC surface, DB schema, streaming, …) |
| [`docs/build-log.md`](docs/build-log.md) | Archive of retired `BUILD_STATE.md` entries (frozen; grep for old citations) |
| [`BUILD_STATE.md`](BUILD_STATE.md) | Live build state; read first when contributing |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed for users, per released version, and the source of each release page's notes |

## For developers

A single Electron app in an npm-workspaces monorepo (`apps/desktop`), built with
`electron-vite` (Electron + React + TypeScript). Storage is the built-in `node:sqlite`; model
runtimes are external sidecars (`llama.cpp`, `whisper.cpp`) so they stay swappable behind
clean service interfaces.

```text
HilbertRaum/
├─ apps/desktop/        # the Electron app (main / preload / renderer + tests)
│  └─ src/main/services # chat, rag, embeddings, reranker, vision, ocr, skills, …
├─ docs/                # architecture, rag, security, packaging, … (see above)
├─ model-manifests/     # per-model YAML (chat, embeddings, reranker, transcriber, translation, vision)
├─ app-skills/          # bundled skills: bank-statement, invoice, document-edit, document-redaction, contract-brief, meeting-protocol, deadline-obligation-finder, what-changed, share-safe-review
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

New here? Read [`BUILD_STATE.md`](BUILD_STATE.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md)
first. They cover the hard rules and the mandatory per-phase ritual (tests green, docs
updated, `BUILD_STATE.md` updated).

## Privacy & security

Nothing you type or import is sent anywhere. The workspace is encrypted at rest (AES-256-GCM,
Argon2id key derivation); an unencrypted workspace exists only in developer builds. An offline guard logs (never blocks) any attempt to
reach a remote host while offline, with local `127.0.0.1`/`localhost` connections exempt, and
a local audit log records activity for you (ids and counts only, never content).

The one inbound door is the local API, and it is opt-in: off by default behind a consent
dialog, loopback-only (`127.0.0.1`/`::1`, no LAN mode exists), alive only while your workspace
is unlocked, protected by an access key by default, structurally closed to browser JavaScript,
and limited to chat completions. There is no route to your documents or conversations, and a
drive policy can forbid it outright. Details in [`docs/local-api.md`](docs/local-api.md).

See [`PRIVACY.md`](PRIVACY.md) and [`docs/security-model.md`](docs/security-model.md); report
vulnerabilities per [`SECURITY.md`](SECURITY.md).

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the ground
rules (no cloud/telemetry, offline-first, never commit weights or user data) and the workflow,
and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community expectations. Work one vertical
slice at a time, add tests, keep `npm run typecheck` clean, and update the docs plus
`BUILD_STATE.md`.

## License

[GPL-3.0-or-later](LICENSE) for the software core. Model weights are not included and carry
their own licenses (see [`docs/model-policy.md`](docs/model-policy.md)). Third-party notices
for the npm packages bundled into packaged builds:
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Our promise: the HilbertRaum core is free software and will stay under GPL-3.0-or-later, in
every version we publish here, forever. To fund its open development, we additionally offer
the same software under commercial licenses (dual licensing), for example for tailor-made
solutions for small businesses, or for embedding in other products without GPL obligations.
That is also why contributions require a lightweight
[Contributor License Agreement](.github/CLA.md); the reasoning is spelled out in
[CONTRIBUTING.md](CONTRIBUTING.md#license-and-cla). Interested in a commercial license? Open
an issue or contact the maintainers.

"HilbertRaum" and the HilbertRaum logo are trademarks; the GPL covers the code, not the name.
Forks and unofficial kits must use their own branding; see [TRADEMARKS.md](TRADEMARKS.md).
