# CLAUDE.md — Working instructions for this repo

Private AI Drive Lite is an **open-source, offline, local-LLM workspace** that runs from a
portable drive. No cloud, no telemetry, all user data local.

## Read these first, in order
1. [`BUILD_STATE.md`](BUILD_STATE.md) — the live handoff/state file. **Always read first.** It says what is done, current decisions, data contracts, and the next actions.
2. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — the phased build plan + analysis.
3. [`CLAUDE_Private_AI_Drive_Lite_MVP.md`](CLAUDE_Private_AI_Drive_Lite_MVP.md) — the original product/architecture spec (source of truth for *what* to build).

## Hard rules (from spec §0)
- **No cloud dependencies. No telemetry. No analytics. No remote crash reporting.**
- Do not call hosted AI APIs (OpenAI/Anthropic/Google/Mistral/etc.).
- Never commit model weights, user data, embeddings, logs, or generated files.
- Keep the app fully usable with **no internet connection**.
- Keep all user data local by default; no plaintext workspace unless explicitly chosen.
- No hardcoded developer-specific absolute paths; don't assume the drive path is identical across OSes.
- Treat Windows as first-class; keep macOS/Linux supported in the architecture.
- Keep service boundaries clean (spec §9.2 interfaces) so runtimes can be swapped.

## Stack (see BUILD_STATE §3 for rationale)
- Electron + React + TypeScript + Vite (`electron-vite`), npm workspaces.
- `node:sqlite` (built-in) for storage. Mock runtime + mock embedder first; real `llama.cpp` later.

## Per-phase ritual (MANDATORY — spec-driven)
At the end of every phase:
1. Tests green (`npm test`). 2. App still builds/launches. 3. **Update affected `docs/`.**
4. **Update `BUILD_STATE.md`** (status, decisions, data contracts, next actions, risks). 5. Commit referencing the phase.

A phase is not done until docs + `BUILD_STATE.md` are updated.

## Commands
```bash
npm install        # install (dev-time only; needs internet once for the Electron binary)
npm run dev        # launch the app
npm run build      # production build
npm test           # unit + integration tests
npm run typecheck  # TypeScript checking
```
