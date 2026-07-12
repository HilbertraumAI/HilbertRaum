# Product vision — HilbertRaum

This is the **durable product intent**: who the product is for, what it monetizes, what it
deliberately does not do, and where it can grow. It condenses the retired original MVP spec
(`CLAUDE_HilbertRaum_MVP.md`, deleted 2026-07-11 — full text: `git show ed1332c:CLAUDE_HilbertRaum_MVP.md`);
the **as-built** system is described by the other topic docs and [`BUILD_STATE.md`](../BUILD_STATE.md).
The spec's §-anchors cited across code and docs resolve through the legend in
[`architecture.md`](architecture.md) "Original MVP spec — retirement record & §-anchor legend".

## Thesis (spec §1.2, §23)

HilbertRaum is an open-source offline AI workspace for normal laptop users. The user plugs in an
external USB-C SSD, launches the app, and gets private offline chat, local document Q&A with
citations, summarization, drafting, translation, and simple reasoning over local files — with no
cloud dependency and no telemetry.

HilbertRaum is **not trying to beat frontier cloud models**. The killer feature is not raw model
size; it is:

> Plug in a trusted drive, ask questions about private documents, and keep everything local.

The product values: private, offline, understandable, useful, portable, open-source, honest about
limits, easy for normal users.

## Target user (spec §1.4)

A normal **European laptop user** who:

- is privacy-conscious and has confidential documents,
- does not want to send prompts or documents to cloud LLMs,
- is **not** comfortable using GitHub, Python, Docker, Ollama, llama.cpp, or terminal commands,
- uses Windows or macOS, has 8–16 GB RAM, and may have no dedicated GPU.

Advanced users who run the app from source are also supported (the DIY path below), but every
feature must work for the non-technical user first. (The UI-facing rendering of this audience —
lawyers, doctors, accountants, consultants, HR — lives in
[`design-guidelines.md`](design-guidelines.md).)

## Success definition (spec §1.5)

The MVP is successful when a non-technical user can:

1. Plug in the drive. 2. Launch the app. 3. Confirm offline mode. 4. Start a local chat.
5. Add a small folder of documents. 6. Ask a question about those documents.
7. Receive an answer with source citations. 8. Close the app. 9. Unplug the drive.
10. **Move the drive to another supported laptop and continue using the same workspace.**

Step 10 is the widely-cited **"success criterion #10"** (drive portability): as-built via the
root launchers that derive `HILBERTRAUM_DRIVE_ROOT` from their own location
([`drive-layout.md`](drive-layout.md) "Launchers") and verified by the second-laptop continuity
check ([`packaging.md`](packaging.md) manual pre-ship checklist).

## Commercial model (spec §1.3)

Two distribution paths:

- **A. Open-source DIY toolkit** — clone the repo, prepare your own drive, download supported
  models, run locally.
- **B. Preconfigured drive** — buy a prepared SSD, plug it in, launch; models preinstalled and
  verified.

The preconfigured commercial product monetizes: **curation, packaging, tested hardware, signed
installers, support, documentation, compliance-focused UX, preloaded model packs, and polished
onboarding**. The software core remains open source (GPL-3.0-or-later — see `README.md` "License").

Naming history: "HilbertRaum" was chosen over the also-considered *Sovereign AI Drive*,
*Offline AI Drive*, *LocalGPT Drive*, and *AI Vault Lite* (spec §1.1).

## Positioning guardrails — the drive is not RAM (spec §0.2, §3.1)

**Never present or market the external drive as "RAM expansion" or a magical performance
booster.** The drive helps by providing portable model storage, a portable encrypted workspace,
fast model loading from a good NVMe SSD, space for indexes/embeddings, a consistent preconfigured
layout, an offline update medium, and a customer-owned data boundary.

The drive does **not** solve:

- insufficient system RAM,
- insufficient VRAM,
- a slow CPU or thermal throttling,
- poor model quality,
- hallucination risks.

**The app must be honest about hardware limits** — this is a product ethic, not just UI copy
(the friendly-wording rule for it is spec §11.4, as-built in [`benchmark.md`](benchmark.md)
"Warnings" and [`design-guidelines.md`](design-guidelines.md) §7).

## Deliberate scope boundaries (spec §2.2)

Still-standing MVP non-goals (deliberate, not omissions):

- image generation (Stable Diffusion / ComfyUI — reserved for a possible Studio edition below)
- agentic browser control
- email/calendar integrations
- cloud fallback of any kind
- team collaboration and multi-user accounts
- enterprise admin console
- fine-tuning / model training
- mobile apps, web hosting
- GPU-specific tuning UI
- paid licensing logic, hardware dongle DRM
- full GDPR compliance automation
- legal/medical advice claims

Two of the spec's original exclusions were later **reversed by shipping**: local voice **input**
(Whisper transcription + dictation, Phase 36/37 — voice *output*/TTS remains out of scope) and
scanned-PDF OCR ("Make searchable", Phase 38).

## Growth directions

### Future editions (spec §19)

A four-tier product ladder beyond the Lite MVP (aspirational; several line-items have since
shipped into the base app — e.g. the reranker, collection scoping, the contract-brief skill,
audio transcription):

- **Office / Knowledge Drive** — better RAG, folder-level knowledge bases, contract review
  workflow, GDPR/DPIA assistant, audit logs, admin settings.
- **Reasoning Drive Pro** — larger models, coding assistant, local tool execution, project
  workspaces, spreadsheet analysis, long-context workflows where hardware permits.
- **Studio Drive** — local image generation (ComfyUI/InvokeAI backend, SDXL/FLUX-class packs
  subject to licensing), prompt assistant, brand/style templates, asset library.
- **Enterprise Drive** — policy enforcement, model allowlist, signed offline updates, central
  provisioning, audit controls, compliance documentation, admin lock, optional hardware-encrypted
  drives.

### Future runtime backends (spec §3.2)

The `ModelRuntime` seam (architecture.md "Swappable interfaces") is meant to allow later support
for an **Ollama-compatible backend**, an **MLX backend** (Apple Silicon), an **ONNX Runtime
backend**, and a **remote enterprise on-prem backend** — none in the MVP. (Vulkan and Metal builds from the same spec list have since shipped; CUDA was
evaluated and rejected as a default — the manifest schema leaves the door open. See the
architecture GPU record.)
