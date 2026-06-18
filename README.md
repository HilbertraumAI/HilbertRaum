# HilbertRaum

> Plug in a trusted drive, ask questions about your private documents, and keep everything local.

HilbertRaum is an **open-source, offline AI workspace** for normal laptop users. It runs
small/medium open-weight language models **locally** — on your laptop's CPU, reading models from a
portable USB-C SSD. Your prompts, documents, embeddings, and chat history never leave your device.

- 🔒 **Private by design** — no cloud, no telemetry, no analytics, no prompt/document upload.
- 🧠 **Local models** — `llama.cpp` runtime with GGUF models (Qwen3 family by default).
- 📄 **Document Q&A** — import PDFs/Word/text, ask questions, get answers **with citations**.
- 🧳 **Portable** — keep models + an encrypted workspace on an external drive; move between laptops.
- 🪟 **Cross-platform architecture** — Windows-first, with macOS/Linux supported in the design.

> The MVP is **feature-complete**, plus GPU acceleration, retrieval-quality, UI-polish, and
> office-functionality waves (document tasks, translation, compare, audio transcription,
> dictation, OCR). See **[`BUILD_STATE.md`](BUILD_STATE.md)** for current status; the original
> phased plan document was retired after completion and lives in git history.

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
- **RAM decides which model you can run** (the app benchmarks your machine and recommends one):
  ≤12 GB → Qwen3-4B · 16–24 GB → Ministral 8B · ≥32 GB → Gemma 4 12B (or the 30B-A3B MoE, opt-in).
- **Disk space:** ~**3 GB** for the smallest usable setup (the 4B chat model + the embeddings model),
  up to ~**10 GB** for the 14B or ~**19 GB** for the 30B-A3B MoE. A **USB-3 SSD** is recommended for
  a portable drive.
- **To build from source:** **Node.js ≥ 22.5** (24 recommended; 22.15+ enables the
  `--use-system-ca` corporate-proxy workaround) + **Git**.
- **The AI itself** = a **GGUF model file** *plus* the **`llama.cpp` `llama-server` binary**. Neither
  ships in this repo (licensing + size); the steps below download and verify them, or you add them by
  hand.

## Getting started (DIY / from source)

### 1. Run the app — no models needed yet

```bash
git clone <this-repo>
cd ai_drive
npm install        # one-time; downloads the Electron binary (needs internet once)
npm run dev        # launches the app
```

With no model files present you can still explore the whole interface: open **AI Model** and click
**Start mock runtime** on a chat model (offered in developer mode, the dev default) — then chat,
document import, Q&A with citations, benchmark and privacy all work on the built-in mock.
**Mock answers are placeholders** (they echo your input) — they are *not* real AI. Add a real
model (step 2) for genuine answers.

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

**To keep setup fast, `-WithAssets` downloads a small but complete default set** — not all ~11
models. It fetches the benchmark-winning mid-tier chat model (Ministral 3 8B, ~5 GB; on a ≤12 GB
machine you may prefer the smaller bundled Qwen3-4B — add it with `-AllModels` or from the AI Model
screen), the **embeddings** model (for document Q&A), the **reranker**, and the **Whisper**
transcriber model, plus **both sidecar
runtimes** (`llama.cpp` for chat/embeddings, `whisper.cpp` for audio). That's enough to chat, ask
questions about your documents, get higher-quality retrieval, and transcribe audio out of the box.
You download any **other** models (larger chat models) **from inside the app** later, on demand. To
provision *every* model up front instead, add `-AllModels` (Windows) / `--all-models` (macOS/Linux).
The sidecar runtimes are fetched either way.

Whatever it fetches, it **SHA-256-verifies** against the manifest and copies the manifests/config
onto the drive. Downloads **resume** if interrupted and re-running **skips** what's already there.
You can also fetch piecemeal (`fetch-models` / `fetch-runtime`, with `--only <id>` for a single
model) or drop the files into `models/` and `runtime/llama.cpp/<os>/` **by hand** — see
**[`docs/packaging.md`](docs/packaging.md)**.

> 🎙️ The whisper.cpp runtime ships **prebuilt for Windows only**; on a macOS/Linux build host
> `-WithAssets` skips it with a note (build it from source — see **[`docs/packaging.md`](docs/packaging.md)**).

> ✅ **`runtime-sources.yaml` is pinned to a real release** (`llama.cpp` **b9585**, real per-OS
> URLs + SHA-256 checksums computed from the actual assets) — `fetch-runtime` downloads, verifies,
> extracts (zip and tar.gz), and flattens the binaries for all three OSes from any host. Model
> weight URLs are real Hugging Face links, and the bundled manifests now carry **real pinned
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

Open **AI Model**, press **Start** on the recommended model, and chat for real. To ship a portable
build instead of `npm run dev`, see `npm run package:win` in **[`docs/packaging.md`](docs/packaging.md)**.

Run tests / type-check: `npm test`, `npm run typecheck`.

## Supported models

Downloaded by the scripts above (or add your own via a manifest). Weights are **never** in the repo.

| Model | Role | Size | Min RAM | License | Source |
|---|---|---|---|---|---|
| Qwen3 4B Instruct Q4 | Chat (smallest / balanced default) | ~2.7 GB | 8 GB | Apache-2.0 | [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF) |
| Qwen3 8B Instruct Q4 | Chat (12 GB+ laptops) | ~5.0 GB | 12 GB | Apache-2.0 | [Qwen/Qwen3-8B-GGUF](https://huggingface.co/Qwen/Qwen3-8B-GGUF) |
| Qwen3 14B Instruct Q4 | Chat (dense, 32 GB+) | ~9.3 GB | 14 GB | Apache-2.0 | [Qwen/Qwen3-14B-GGUF](https://huggingface.co/Qwen/Qwen3-14B-GGUF) |
| Qwen3 30B-A3B (MoE) Q4 | Chat (≈30B quality, ≈3B speed) | ~18.6 GB | 24 GB | Apache-2.0 | [Qwen/Qwen3-30B-A3B-GGUF](https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF) |
| Ministral 3 8B Instruct (2512) Q4 | Chat (**recommended 8B** — benchmark winner) | ~5.2 GB | 12 GB | Apache-2.0 | [mistralai/Ministral-3-8B-Instruct-2512-GGUF](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF) |
| Granite 4.1 8B Q4 | Chat (challenger — not auto-recommended) | ~5.3 GB | 12 GB | Apache-2.0 | [ibm-granite/granite-4.1-8b-GGUF](https://huggingface.co/ibm-granite/granite-4.1-8b-GGUF) |
| Gemma 4 12B Instruct QAT Q4_0 | Chat (**recommended 12–14B** — benchmark winner; has Deep) | ~7.0 GB | 14 GB | Apache-2.0 | [google/gemma-4-12B-it-qat-q4_0-gguf](https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf) |
| Qwen3 4B Instruct 2507 Q4 | Chat (better 4B quality; no Deep) | ~2.5 GB | 8 GB | Apache-2.0 | [unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) |
| Multilingual E5 Small (F16) | Embeddings (document search) | ~0.24 GB | 4 GB | MIT | GGUF: [keisuke-miyako/…-f16](https://huggingface.co/keisuke-miyako/multilingual-e5-small-gguf-f16) · orig: [intfloat/…](https://huggingface.co/intfloat/multilingual-e5-small) |

Document Q&A needs the **embeddings** model; chat needs **one** of the chat models. The benchmark
auto-recommends the best model that fits your RAM (Phase-29 quality-aware: **≤12 GB → Qwen3-4B,
16–24 GB → Ministral 8B, ≥32 GB → Gemma 4 12B**); the **30B-A3B MoE** is opt-in (≈30B quality at
≈3.3B *active* params/token → near-small-model CPU speed **if** its ~18.6 GB fits in RAM). The
original Qwen3-4B stays the bundled default (it keeps **Deep** answer mode); Granite is selectable
but not recommended (it lost its tier in the benchmark). Bigger **dense** models are smarter but
slower on CPU — pick by your RAM. The full schema + license policy is in
**[`docs/model-policy.md`](docs/model-policy.md)**; per-model details live in
[`model-manifests/`](model-manifests).

## Two distribution paths

- **Open-source DIY toolkit** — clone this repo, prepare your own drive, download supported models
  (the path above).
- **Preconfigured drive** *(commercial)* — a prepared SSD with tested hardware, a signed/notarized
  app, preloaded + verified models, and double-click onboarding (built by
  `scripts/build-commercial-drive.*`; see [`docs/packaging.md`](docs/packaging.md)). The
  software core stays open source.

## Privacy

See [`PRIVACY.md`](PRIVACY.md). Short version: nothing you type or import is sent anywhere.

## License

[GPL-3.0-or-later](LICENSE) for the software core. Model weights are **not** included and carry their own
licenses (see [`docs/model-policy.md`](docs/model-policy.md)).
