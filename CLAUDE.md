# CLAUDE.md — Working instructions for this repo

HilbertRaum is an **open-source, offline, local-LLM workspace** that runs from a
portable drive. No cloud, no telemetry, all user data local.

## Read these first, in order
1. [`BUILD_STATE.md`](BUILD_STATE.md) — the live handoff/state file. **Always read first.** It says what is done, current decisions, data contracts, and the next actions.
2. [`CLAUDE_HilbertRaum_MVP.md`](CLAUDE_HilbertRaum_MVP.md) — the **frozen** original product/architecture spec (source of truth for *what* to build / intent). For the **as-built** system the topic docs below and `BUILD_STATE.md` supersede any specific that has since changed — see the banner at the top of that file.
3. Topic docs under [`docs/`](docs/) (architecture, drive layout, packaging, model policy, …) as the task requires.

## Doc lifecycle rule
Implementation **plan** documents are working papers: once a plan is fully implemented, condense
it into a short **design record** (decisions + the facts they rest on + the design as built)
**folded into the relevant topic doc as a §-numbered section**, and delete the plan file — the
full original stays in git history. Don't let finished plans linger; they drift and contradict
the code. Keep the record's §-anchors stable: code comments cite them. Templates:
`docs/rag-design.md` §12 (Phase-21 record) and `docs/architecture.md` "GPU acceleration —
design record" (§1–§8). A standalone plan file should only exist for work that is still open
(e.g. `docs/big-slot-embeddings-plan.md`). Even a just-closed wave whose plan is heavily cited
as a unit can be retired: fold its decisions + research into the topic doc and add a
**§-anchor legend** that keeps the historical `§N` citations resolvable without churning the
comments — see `docs/architecture.md` "Functionality wave 3 — design record" (its §-anchor
legend), and the Skills / Image-understanding records.

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
- `node:sqlite` (built-in) for storage. Mock runtime + mock embedder for dev/test; real `llama.cpp` runtime + embeddings integrated (Phase 10).

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
npm run package    # portable build via electron-builder (manual, network-touching — R2)
npm run package:win # Windows portable .exe specifically
```
