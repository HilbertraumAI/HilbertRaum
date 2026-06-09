# Phase 10 kickoff prompt — real llama.cpp runtime & real embeddings

> Paste this as the kickoff prompt for the next session. It mirrors the Phase 8/9 handoff style.

---

You are continuing work on the **Private AI Drive Lite** project (an open-source, offline,
local-LLM desktop app) located at `f:\_coding\ai_drive`.

## START BY READING, IN THIS ORDER

1. **`BUILD_STATE.md`** — the live handoff/state file (current status, decisions, data
   contracts, next actions, risks). Source of truth for where we are. Read **§5 (START OF
   PHASE 10)** carefully, the **Models + runtime (Phase 2 live)**, **Streaming contract
   (LOCKED — Phase 3)**, **Embeddings + vector search (Phase 5 live)**, **Hardware benchmark
   (Phase 7 live)**, and **Privacy & offline policy (Phase 8 live)** contract sections, plus
   the **Encrypted workspace (Phase 9 live)** section. In the **Decisions log**, note the
   `node:sqlite`/Electron-37 pin, the **mock-first** decision, the **loopback-exception**
   (LOCKED, Phase 8: `127.0.0.0/8`/`::1`/`localhost` are **not** "network" — the llama.cpp
   sidecar binds `127.0.0.1`), and the **vector BLOB encoding / dimensions=384 (LOCKED)** entry.
2. **`docs/IMPLEMENTATION_PLAN.md`** — read the **Phase 10** section (deliverables:
   `runtime/llama.ts` `LlamaRuntime` spawning `llama-server` on `127.0.0.1` with a random local
   port, streaming via the OpenAI-compatible endpoint, shutdown on exit, health check, timeouts;
   real `Embedder`; sidecar discovery under `runtime/`; drive layout `runtime/llama.cpp/<os>/`),
   the **§4b critique** (the "honesty about scope" paragraph: Phase 10 has **manual,
   hardware-dependent acceptance** — real llama.cpp needs platform binaries + a GGUF model not in
   the repo), AND the **"Per-phase ritual"** (§3).
3. **`CLAUDE.md`** — the hard rules (no cloud, no telemetry, local-only, **no hosted AI APIs**,
   swappable interfaces per spec §9.2, keep the app fully usable **with no internet**). Phase 10
   is where real *local* inference lands — it must stay 100% offline (loopback only) and fall back
   gracefully when no model/binary is present.
4. **`docs/architecture.md`** (create/extend) + **`docs/benchmark.md`** — the runtime/embedder
   architecture and how the benchmark's `measureTokensPerSecond` already drives off
   `runtime.chatStream` (so real tokens/sec becomes live the moment a real runtime streams).
5. **`CLAUDE_Private_AI_Drive_Lite_MVP.md`** — the source of truth for *what* to build:
   - **§3.2 (Local inference)** + **§7.5 (Runtime manager / model server)** — spawn a local
     `llama.cpp` server, **bound to `127.0.0.1` only, never the LAN**, health-checked, cleanly shut
     down on exit; one active runtime, restart on model switch.
   - **§9.2 (Service interfaces)** — `ModelRuntime` + `Embedder` are the swap points; the real
     backends drop in **behind the existing interfaces** with no caller changes.
   - **§6 (Drive layout)** — `runtime/llama.cpp/<os>/` for the sidecar binaries; `models/...` for
     the GGUF weights (already where manifests resolve `local_path`).
   - **Milestone 2 (real criteria)** (acceptance: sidecar starts/stops, health works, a real local
     model answers a prompt, localhost-only, not LAN-exposed) + **§15** (tests: port binding
     localhost-only, process cleanup on quit, health-timeout handling — live model test is manual).

## CONTEXT: Phases 0–9 are complete and committed (latest commit `add79b3` "Phase 9 / Milestone 9: encrypted workspace")

- **Phase 9** delivered `services/security/crypto.ts` (scrypt KDF + AES-256-GCM, password
  verifier), `services/workspace-vault.ts` (whole-DB-**file** encryption-at-rest + the
  `WorkspaceController` lock/unlock lifecycle), the four `workspace:*` IPC channels, the
  `WorkspaceGate` onboarding/unlock UI, and made `AppContext.db` a **getter** over the controller
  (throws while locked). **The encrypted workspace is transparent to Phase 10** — the runtime and
  embedder read/write the DB through `ctx.db` exactly as before, whether encrypted or plaintext.
- **All 161 tests pass**; typecheck clean; `NODE_OPTIONS=--use-system-ca npm run build` green (main
  bundle 81.64 kB). No new dependencies. Multiple core paths carry a **no-network assertion** (spy
  `http`/`https`/`net`/`net.Socket`/`fetch`) — ⚠️ for Phase 10 this means **loopback (127.0.0.1)
  connections to the sidecar are allowed** (the offline guard exempts loopback); do **not** write an
  assertion that forbids the sidecar's local socket. Reuse the spy pattern only for paths that must
  make *zero* sockets (e.g. embedder construction, manifest discovery).

### Things already in place for Phase 10 (do not rebuild)

- **`services/runtime/index.ts`** — the `ModelRuntime` interface (`modelId`, `start()`, `stop()`,
  `health(): HealthStatus`, `chatStream(messages, options): AsyncGenerator<string>`),
  `RuntimeChatOptions { maxTokens?, temperature?, signal? }`, `RuntimeStartOptions { modelId,
  modelPath, contextTokens }`, `HealthStatus { healthy, message, port }`, and `RuntimeManager`
  (single active runtime, restart-on-switch, `RuntimeFactory` swap point). **The header already
  says "Real runtimes MUST bind 127.0.0.1 only."** Phase 10 adds `LlamaRuntime` behind this
  interface — do not change the interface or the manager.
- **`services/runtime/mock.ts`** — `MockRuntime` + `createMockRuntime`. `main/index.ts` builds
  `new RuntimeManager(createMockRuntime)`. Phase 10 swaps the **factory** for a selector that
  returns `LlamaRuntime` when the sidecar binary + GGUF weights are present, else falls back to the
  mock (keep the mock — it is how `npm run dev` + every test runs with zero model files).
- **`ipc/registerModelIpc.ts`** `startRuntime` already resolves `modelPath = weightPath(rootPath,
  manifest)` + `contextTokens` and calls `ctx.runtime.start({ modelId, modelPath, contextTokens })`.
  Wire the real runtime **through this existing path** — the IPC, preload, and Models screen need no
  new surface to start/stop a real model.
- **`services/embeddings/index.ts`** — the `Embedder` interface (`id`, `dimensions`, `embed(texts)
  => Promise<Float32Array[]>` L2-normalized), `encodeVector`/`decodeVector`, `cosineSimilarity`, and
  `VectorIndex`. **`mock.ts`** has `MockEmbedder` + `createMockEmbedder` (`main/index.ts` uses it).
  **Dimensions = 384 and the Float32 BLOB encoding are LOCKED** and already match the E5-small
  manifest, so the real embedder is a drop-in by id/dims.
- **Manifests** (`model-manifests/`): chat = `qwen3-1.7b/4b/8b-instruct-q4` (`runtime: llama_cpp`,
  `format: gguf`); embeddings = `multilingual-e5-small-q8` (`runtime: llama_cpp`, `format: gguf`,
  `dimensions: 384`, `local_path: models/embeddings/multilingual-e5-small-q8.gguf`). All carry
  `sha256: REPLACE_WITH_REAL_HASH` (real hashes land with real weights — verification is gated by
  `developerMode` / policy `requireSha256Match`). The model-state machine
  (`missing`/`checksum_failed`/`installed`/`unsupported`/`not_recommended`/`ready`/`running`) already
  models "weights absent".
- **`services/benchmark.ts`** `measureTokensPerSecond(runtime)` already drives off
  `runtime.chatStream` (prompt + `BENCHMARK_TOKEN_TARGET` tokens) and returns `null` when no runtime
  is active — so **real tokens/sec, the low-tok/sec profile downgrade, and the GPU bump go live
  automatically** once `LlamaRuntime` streams. No benchmark rewrite needed.
- **`services/offlineGuard.ts`** exempts `127.0.0.0/8`/`::1`/`localhost` and **only logs** remote
  attempts (never blocks). The sidecar's loopback socket is allowed by design.
- **`AppContext`** carries `runtime: RuntimeManager` + `embedder: Embedder` (+ the Phase-9
  `workspace`). `main/index.ts` `will-quit` already stops the runtime **and** locks the workspace —
  the sidecar process-cleanup hook belongs alongside the existing `runtime.stop()`.

## YOUR TASK: Implement Phase 10 — "Real llama.cpp runtime & real embeddings" (spec Milestone 2 real)

Follow `BUILD_STATE` §5 and the Phase 10 plan section, in order:

1. **`services/runtime/sidecar.ts` (new) — sidecar discovery + lifecycle helpers.** Locate the
   `llama-server` binary under `runtime/llama.cpp/<os>/` (per spec §6; allow a `PAID_LLAMA_BIN` env
   override for dev). Pure, testable resolution (`resolveLlamaServerPath(rootPath, platform)` →
   path | null) so a "binary present?" check has no I/O surprises. Pick a **random free local port**
   and helpers to spawn/kill the child process.

2. **`services/runtime/llama.ts` (new) — `LlamaRuntime implements ModelRuntime`.**
   - **`start()`** spawns `llama-server` via `child_process.spawn` bound to **`127.0.0.1` only**
     (`--host 127.0.0.1 --port <random>`), with `--model <modelPath>`, `--ctx-size <contextTokens>`,
     and a sane thread count. ⚠️ **Never bind `0.0.0.0` or a routable interface.** Poll the
     server's health endpoint with a **timeout** before reporting healthy; a failed/timed-out start
     `throw`s a clear error (no model file, binary crash, port in use).
   - **`chatStream(messages, options)`** calls the server's **OpenAI-compatible**
     `/v1/chat/completions` with `stream: true`, mapping `messages` (role/content) directly (the
     server applies the model's chat template), and `maxTokens`/`temperature`. Parse the SSE token
     deltas and `yield` each text chunk; honour `options.signal` (abort → stop the fetch + the
     generator). This feeds the **LOCKED Phase-3 streaming contract** unchanged.
   - **`health()`** → `{ healthy, message, port }` from the health endpoint; **`stop()`** kills the
     child (and waits for exit) so no orphan survives. Use **loopback fetch** (`http://127.0.0.1:
     <port>`) — exempt from the offline guard.
   - **Graceful fallback:** the runtime **factory selector** (in `main/index.ts`, replacing the bare
     `createMockRuntime`) returns `LlamaRuntime` only when the binary **and** the GGUF weights for
     that model exist; otherwise it returns the mock (or surfaces a clear "model missing" status via
     the existing model-state machine). The app must still launch + the suite must still pass with
     **zero model files**.

3. **Real embedder (`services/embeddings/llama.ts` or `e5.ts`, new) — `Embedder`.** Implement the
   E5-small embedder behind the existing interface (`id` = the manifest id, `dimensions = 384`,
   `embed()` returns **L2-normalized** `Float32Array`s). Prefer a llama.cpp embeddings server
   (`llama-server --embedding`, loopback) **or** an ONNX path — whichever is the smaller, dependency-
   light add (document the choice; avoid fragile native builds — see R-notes). Swap it into
   `main/index.ts` behind the same availability check (real when weights present, else
   `createMockEmbedder`).
   - ⚠️ **Embedding-model mismatch gotcha:** mock vectors (`embedding_model_id = 'mock-embedder'`)
     and real E5 vectors are **both 384-dim**, so `VectorIndex`'s dimension guard will NOT separate
     them — mixing them silently corrupts ranking. Handle the switch: either **filter the search by
     the active `embedding_model_id`**, or **re-embed on model change** (a "reindex" pass). Decide +
     document; add a test for the filter/reindex so a mock→real switch can't blend vector spaces.

4. **App-shell wiring (`main/index.ts`).** Replace the hardcoded `createMockRuntime` /
   `createMockEmbedder` with the availability-aware selectors. Ensure `will-quit` (which already
   stops the runtime + locks the workspace) reliably **kills the sidecar** (no orphaned
   `llama-server`). Keep everything offline: the only sockets are loopback to the sidecar.

5. **Tests** (keep all **161** existing green): `resolveLlamaServerPath` resolution (binary present
   / absent / env override) — pure, no spawn; the **factory selector** picks mock when binary/weights
   are absent (so dev + CI stay on the mock); **localhost-only** assertion (the spawn args / fetch
   URL are `127.0.0.1`, never `0.0.0.0`/LAN); **process cleanup on stop/quit** (mock the child
   process — assert `kill` is called, no orphan); **health-timeout handling** (a server that never
   becomes healthy → `start()` throws cleanly, no hang); the **embedding-model-mismatch** filter/
   reindex test from step 3. **Live real-model inference is a MANUAL acceptance step (R5)** — needs a
   GGUF + platform binary not in the repo; gate it behind an env/skip, don't add it to the suite.
   Test the **services directly** (sidecar resolution, the runtime with a mocked child/fetch, the
   embedder) — the `register*Ipc` modules import `electron`.

6. **Ritual:** docs — write/extend **`docs/architecture.md`** (the runtime: sidecar discovery,
   localhost-only binding, OpenAI-compatible streaming, health/timeout, shutdown; the embedder
   choice + the embedding-model-mismatch handling) and **`docs/packaging.md`** (where the
   `runtime/llama.cpp/<os>/` binaries + `models/*.gguf` live, and that they are git-ignored / not in
   the repo). Bump `_Last updated_`. Refresh `docs/benchmark.md` (tokens/sec is now real). Update
   `BUILD_STATE.md` (mark Phase 10 done; add contracts for `LlamaRuntime` / the sidecar / the real
   `Embedder` / the factory selector / the embedding-model filter; set **Phase 11 — drive layout,
   prepare-drive scripts & packaging** as next actions; log decisions [sidecar discovery + env
   override, localhost-only binding, OpenAI-compatible streaming endpoint, real-embedder backend
   choice + why, embedding-model-mismatch handling, graceful-fallback rule] and risks). Commit.

## Notes / gotchas

- **Localhost-only is non-negotiable.** Bind/spawn/fetch `127.0.0.1` exclusively. The Phase-8
  offline guard exempts loopback for exactly this; a routable bind would expose local inference to
  the LAN and violate the spec. The no-network assertions assume loopback-only.
- **Keep the mock — it is the zero-model default.** `npm run dev` and the entire test suite run with
  no GGUF files. The real backends are **opt-in by availability** (binary + weights present), behind
  the same `ModelRuntime`/`Embedder` interfaces. Never make a real model file a precondition for the
  app to launch or for tests to pass.
- **Embedding-model mismatch (the subtle one).** Both mock and real E5 vectors are 384-dim, so the
  dimension guard won't protect you. Filter retrieval by the active `embedding_model_id` **or**
  re-embed on switch — otherwise a corpus indexed under the mock will silently pollute real search.
- **OpenAI-compatible endpoint applies the chat template server-side.** Send `messages` as
  role/content to `/v1/chat/completions`; do not hand-roll Qwen's prompt format. Map `maxTokens` /
  `temperature` / `stream`. Parse SSE deltas → `yield` text; abort on `options.signal`.
- **Process hygiene.** Kill the sidecar on `stop()` **and** `will-quit`; wait for exit. A health
  poll must **time out** (don't hang the app on a wedged server). Port-in-use → pick another / fail
  clearly.
- **No fragile native deps.** Prefer the `llama-server` sidecar (a prebuilt binary discovered at
  runtime, not an npm native module) and loopback HTTP over an in-process native binding. If you add
  an ONNX/embedding lib, keep it pure-JS/prebuilt and `NODE_OPTIONS=--use-system-ca npm install …`
  (R6). Document any new dep in BUILD_STATE.
- **R5 — real llama.cpp is manual.** Platform sidecar binaries + a GGUF model are **not** in the
  repo, so live inference is a manual acceptance step. Everything else (discovery, fallback,
  localhost binding, cleanup, health-timeout, the embedder swap mechanics) is automatable with mocked
  child/fetch — write those.
- **Phase 9 is transparent.** Encryption is storage-at-rest; the runtime/embedder use `ctx.db`
  unchanged. The sidecar reads **weights** (plaintext GGUF under `models/`), not the encrypted DB.

## ENVIRONMENT NOTES (important)

- **Verify commands** (from repo root): `npm run typecheck`, `npm test`, and
  `NODE_OPTIONS=--use-system-ca npm run build`. **Green = typecheck + test + build.** ESLint is NOT
  installed; `npm run lint` fails by design and is NOT part of green. Live `npm run dev` (and any
  real-model smoke) is a manual step — don't block on it.
- **All 161 existing tests must stay green.** Platform is Windows/PowerShell; `node:sqlite` lives in
  Electron's bundled Node (Electron 37 / Node 22.21) but tests run under system Node 24 via vitest.
  Rust/Cargo + Python are **NOT installed** (so no source-built native modules — use prebuilt
  sidecar binaries). Use the `freshDb` + vitest-spy patterns from Phases 5–9.
- The `register*Ipc` modules import `electron`, so (as in prior phases) **test the services
  directly** (sidecar resolution, `LlamaRuntime` with a mocked child process / mocked loopback
  fetch, the real `Embedder`, the factory selector) rather than the `ipcMain` handlers.

## END-OF-PHASE RITUAL (mandatory — a phase is not done until this is complete)

1. `npm test` (all green) + `npm run typecheck` (clean) + `NODE_OPTIONS=--use-system-ca npm run
   build` (green).
2. Update affected docs: `docs/architecture.md` (real runtime + embedder design),
   `docs/packaging.md` (sidecar/weights layout, git-ignored), `docs/benchmark.md` (real tokens/sec),
   bump `_Last updated_`.
3. Update `BUILD_STATE.md`: mark Phase 10 done, refresh data contracts (`LlamaRuntime` / sidecar /
   real `Embedder` / factory selector / embedding-model filter), set **Phase 11 (drive layout,
   prepare-drive scripts & packaging)** as next actions, log new decisions and any risks.
4. Commit referencing **"Phase 10 / Milestone 2 (real)"**. Use `git -C f:/_coding/ai_drive` for git
   (note: forward slashes — backslashes get mangled by the Bash tool), and end the commit message
   with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   (When committing via the Bash tool, pass the message with a here-doc `-F -`, **not** PowerShell
   `@'...'@`.)

When done, report what was built, test results, and what Phase 11 will tackle.
