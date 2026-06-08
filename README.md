# Private AI Drive Lite

> Plug in a trusted drive, ask questions about your private documents, and keep everything local.

Private AI Drive Lite is an **open-source, offline AI workspace** for normal laptop users. It runs
small/medium open-weight language models **locally** — on your laptop's CPU, reading models from a
portable USB-C SSD. Your prompts, documents, embeddings, and chat history never leave your device.

- 🔒 **Private by design** — no cloud, no telemetry, no analytics, no prompt/document upload.
- 🧠 **Local models** — `llama.cpp` runtime with GGUF models (Qwen3 family by default).
- 📄 **Document Q&A** — import PDFs/Word/text, ask questions, get answers **with citations**.
- 🧳 **Portable** — keep models + an encrypted workspace on an external drive; move between laptops.
- 🪟 **Cross-platform architecture** — Windows-first, with macOS/Linux supported in the design.

> This is an MVP under active construction. See **[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)**
> for the phased roadmap and **[`BUILD_STATE.md`](BUILD_STATE.md)** for current status.

## Status

The build proceeds in phases (mock-first, so it runs with **no model files and no network**).
Current phase and progress are tracked in [`BUILD_STATE.md`](BUILD_STATE.md).

## DIY setup (advanced users)

Requirements: **Node.js ≥ 22** (Node 24 recommended). Git.

```bash
git clone <this-repo>
cd ai_drive
npm install        # one-time; downloads the Electron binary (needs internet once)
npm run dev        # launches the app
```

Run tests:

```bash
npm test
npm run typecheck
```

> The dependency install is the **only** step that touches the network. The application itself
> makes no network calls in its core path.

## Two distribution paths

- **Open-source DIY toolkit** — clone this repo, prepare your own drive, download supported models.
- **Preconfigured drive** *(commercial, later)* — a prepared SSD with tested hardware, signed
  installers, preloaded models, and polished onboarding. The software core stays open source.

## Privacy

See [`PRIVACY.md`](PRIVACY.md). Short version: nothing you type or import is sent anywhere.

## License

[Apache-2.0](LICENSE) for the software core. Model weights are **not** included and carry their own
licenses (see [`docs/model-policy.md`](docs/model-policy.md)).
