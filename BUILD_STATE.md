# BUILD STATE — Private AI Drive Lite

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`CLAUDE.md`](CLAUDE.md)).
> It carries: current status, decisions, shared data contracts, next actions, open issues.

_Last updated: 2026-06-10 — **MVP feature-complete: Phases 0–13 done**, plus the full **GPU
acceleration feature (Phases 14–16: Vulkan-default distribution → probe + fallback-ladder runtime
→ Settings/Diagnostics/benchmark surface)** per the IMPLEMENTED
[`docs/gpu-support-plan.md`](docs/gpu-support-plan.md). Four post-MVP audit rounds plus a
**GPU-feature audit round (2026-06-10, post-Phase-16 — see the §3 entry)** are fully
remediated and the llama.cpp runtime pin + license reviews are complete — summarized in §8. The
first real Windows `D:\` portable-drive bring-up surfaced + fixed a cluster of provisioning,
drive-root path, manifest-source and RAG/embedding bugs — see **§9**. A **post-MVP UX polish
round (2026-06-10)** added conversation deletion, a persisted checksum cache (+ real
verify/loading UX), startup auto-start of the active model, and the Home → documents-chat
navigation fix — see the §3 entry. **The Office-edition functionality wave has started**
([`docs/post-mvp-functionality-plan.md`](docs/post-mvp-functionality-plan.md)): **Phase 17 (RAG
trust & document-scoped asking) is DONE** — ask-selected-documents scope, the plain-chat
document-awareness notice, the vector-tag fix, and the reindex-needed answer (§3 entry; design
record `docs/rag-design.md` §10). **Phase 18 (in-app model downloader) is DONE** — triple-gated
(policy ∧ default-off setting ∧ per-download confirmation), `.part` + verify-before-rename,
Range resume, async-with-polling IPC (§3 entry; plan §6 "as implemented"). **Phase 19 (audit
log on `runtime_events`) is DONE** — never-throws recorder with locked-vault buffering,
hard privacy rule (ids/filenames/counts, never content — sentinel-grep-tested), 5 000-row
prune-on-insert retention, shallow IPC-layer wiring incl. the Phase-18 download events, and
the Diagnostics Activity panel + export (§3 entry; plan §7.1 "as implemented"). **Phase 20
(answer-depth modes Fast/Balanced/Deep) is DONE — wave 1 is complete**: the composer depth
selector wires Qwen3's native thinking via per-request `chat_template_kwargs.enable_thinking`
(verified against the pinned b9585), Deep streams a collapsed live "Thinking…" block over the
ADDITIVE `chat:reasoning:<id>` channel, and reasoning is stripped from persistence + replayed
history (§3 entry; plan §8.1 / decisions D4+D5 resolved). Release-wise, remaining work =
**manual release acceptance only** (§5, incl. the GPU
hardware matrix, item 1b). Consciously-accepted gaps live in
[`docs/known-limitations.md`](docs/known-limitations.md)._

---

## 1. Current status

| Phase | Name | Status |
|---|---|---|
| 0 | Repo skeleton & tooling | 🟢 done |
| 1 | App shell, workspace & settings | 🟢 done |
| 2 | Model manifests & runtime contract | 🟢 done |
| 3 | Basic chat (mock runtime) | 🟢 done |
| 4 | Document ingestion & chunking | 🟢 done |
| 5 | Embeddings & vector search (mock) | 🟢 done |
| 6 | RAG chat with citations | 🟢 done |
| 7 | Hardware benchmark & recommendation | 🟢 done |
| 8 | Privacy & offline hardening | 🟢 done |
| 9 | Encrypted workspace | 🟢 done |
| 10 | Real llama.cpp runtime & embeddings | 🟢 done |
| 11 | Drive layout, scripts & packaging | 🟢 done |
| 12 | DIY asset loader (`fetch-assets`) | 🟢 done |
| 13 | Plug-and-play distribution (commercial drive) | 🟢 done |
| 14 | GPU distribution (Vulkan default + CPU safety net) | 🟢 done |
| 15 | GPU runtime (probe, fallback ladder, embedder pin) | 🟢 done |
| 16 | GPU surface (Settings/Diagnostics/benchmark/docs) | 🟢 done |
| 17 | RAG trust & document-scoped asking | 🟢 done |
| 18 | In-app model downloader | 🟢 done |
| 19 | Audit log (`runtime_events`) | 🟢 done |
| 20 | Answer-depth modes (Fast/Balanced/Deep) | 🟢 done |

Legend: ⚪ not started · 🟡 in progress · 🟢 done · 🔴 blocked

> Phases 12–13 are the **post-MVP** distribution phases; Phases 14–16 added GPU acceleration on
> top (see [`docs/gpu-support-plan.md`](docs/gpu-support-plan.md)). All are DONE — see
> [`docs/provisioning-and-distribution-plan.md`](docs/provisioning-and-distribution-plan.md).
> Remaining for *release* = **manual acceptance only**: a real signed/notarized build + a USB §17
> demo (R5/R7) + the GPU hardware matrix (§5 item 1b).
> **Phases 17–20 are the functionality wave toward the Office edition — ALL DONE** — see
> [`docs/post-mvp-functionality-plan.md`](docs/post-mvp-functionality-plan.md). Phase 17 is DONE
> (plan §5, deviations in §5.5; design record in `docs/rag-design.md` §10). Phase 18 is DONE
> (plan §6, "as implemented" note in §6.5). Phase 19 is DONE (plan §7, "as implemented" note
> in §7.1; data class in `docs/security-model.md`). Phase 20 is DONE (plan §8, "as implemented"
> note in §8.1; decisions D4/D5 resolved in §13; mechanism doc in `docs/architecture.md`).

---

## 2. Environment (verified 2026-06-09)

| Tool | Status |
|---|---|
| Node | v24.13.0 ✅ |
| npm | 11.6.2 ✅ |
| corepack | 0.34.5 ✅ (pnpm available if needed) |
| git | 2.54.0.windows.1 ✅ |
| winget | available ✅ |
| Rust / Cargo / rustup | ❌ NOT installed |
| Python | ❌ NOT installed |

OS: Windows 11 Pro (10.0.26200). Shell: PowerShell + bash both available.
Repo root: `f:\_coding\ai_drive`.

---

## 3. Decisions log

- **Stack = Electron + React + TS + Vite** (user choice; Rust not installed). Spec §4 permits Electron fallback.
- **Package manager = npm** with workspaces.
- **SQLite = `node:sqlite`** → fallback `sql.js` (WASM) if unstable. Avoid native `better-sqlite3`.
  ⚠️ **`node:sqlite` lives in the bundled Node of *Electron's main process*, not the system Node.**
  It needs Node ≥ 22.5. Electron 33 bundles Node 20 (no `node:sqlite`), so **Electron is pinned to
  `^37` (Node 22.x)**. Validate `node:sqlite` *inside Electron* at the start of Phase 1, not against
  system Node.
- **Mock-first:** `MockRuntime` + `MockEmbedder` so the app runs with zero model files. Real llama.cpp/embeddings deferred to Phase 10, behind the same interfaces.
- **Vector search = cosine over SQLite-stored vectors** for MVP.
- **Plaintext dev workspace allowed in dev**; encrypted is the commercial default (Phase 9).
- **YAML parsing = `yaml` npm package** (Phase 2 decision). Pure JS, no native deps, MIT, offline.
  Chosen over hand-rolling for reliability; parsing happens in the main process only. Validation is a
  hand-written pure function in `shared/manifest.ts` so it is shared with the renderer and unit-tested
  without I/O.
- **Manifest `local_path` is relative to the drive root** (existing Phase 0 manifests already include
  the `models/` prefix), so weight files resolve to `<root>/models/...`. Recommendation is data-driven
  via an optional `recommended_profiles` list on each manifest.
- **Ingestion parser libs (Phase 4): pure-JS, lazy-imported, externalized.** `pdfjs-dist` (PDF),
  `mammoth` (DOCX), `papaparse` (CSV) — no native deps, consistent with the `node:sqlite` choice.
  Imported lazily inside `parse()`. Marked **external** via `externalizeDepsPlugin` in
  `electron.vite.config.ts` (also externalizes `yaml`) so the large pdfjs ESM bundle is
  `require`/`import`-ed from `node_modules` instead of bundled (resolves R3). Main bundle shrank
  253 kB → 47 kB as a result.
- **PDF parsing approach (Phase 4):** use pdfjs-dist's **legacy** build
  (`pdfjs-dist/legacy/build/pdf.mjs`), which runs in the Node main process with **no Web Worker /
  no DOM** (validated). The `standardFontDataUrl` warning is harmless (rendering-only). Minimal
  ambient typings in `parsers/pdfjs.d.ts` (pdfjs ships no `exports` map for the legacy path).
- **Imported files are copied into the workspace** (`workspace/documents/`, `stored_path`), keeping
  `original_path` too → self-contained, re-indexable drive (spec privacy ethos). See Phase-4 contract.
- **Import = async with polling** (not the chat stream): documents table is per-file truth, job
  aggregate is in-memory via `getImportJob`. See Phase-4 contract for rationale.
- **Embedder placement (Phase 5):** `services/embeddings/` behind an `Embedder` interface
  (spec §9.2), mirroring `ModelRuntime`. A single `embedder` lives on `AppContext` (created in
  `main/index.ts` as `createMockEmbedder()`); the real E5/llama.cpp embedder is a localized
  Phase-10 swap. Ingestion takes the embedder as **optional deps** (`{ embedder?,
  embeddingModelId? }`) so Phase-4 callers/tests stay valid (no embedder → pass-through).
- **Vectors = `Float32Array`** (not `number[][]`) so BLOB encoding is a direct byte view and the
  real GGUF embedder fills typed arrays without conversion. **Dimensions = 384**, matching the
  E5-small manifest (`multilingual-e5-small-q8`) so the real swap is drop-in.
- **Embedding BLOB encoding (LOCKED):** `vector_blob` = raw little-endian Float32 bytes
  (`Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)`). Decode **copies** into a fresh
  4-byte-aligned buffer first (SQLite blobs can be unaligned → `Float32Array` view would
  otherwise `RangeError`). Tagged with `settings.activeEmbeddingModelId`, falling back to
  `embedder.id`.
- **Vector search = linear scan cosine** over the `embeddings` table for MVP (`VectorIndex`),
  with an ANN (sqlite-vec/HNSW) upgrade path behind the same `search` signature.
- **MockEmbedder = feature hashing** (SHA-256 tokens → signed buckets → L2-normalize),
  deterministic + fully offline (uses only `node:crypto`).
- **RAG service placement (Phase 6):** `services/rag/` (separate from `chat.ts`) holds the
  whole grounded path — `retrieve`, `buildGroundedPrompt`, `buildGroundedChatMessages`,
  `generateGroundedAnswer`, and the retrieval-settings mapper — reusing chat helpers
  (`appendMessage`/`listMessages`/`BASE_SYSTEM_PROMPT`) so the Phase-3 chat path is
  untouched. `askDocuments` is its own IPC module (`registerRagIpc.ts`).
- **Retrieval defaults (spec §7.8, LOCKED on `AppSettings`):** `ragTopKInitial = 12`,
  `ragTopKFinal = 6`, `ragMaxContextTokens = 2500`, `ragMinSimilarity = 0`. Read per request
  via `ragSettingsFrom(settings)`.
- **Dedup strategy:** dedup retrieved chunks by `(document_id, page_number)`, keeping the
  highest-scoring chunk per page. Page-less chunks (txt/md) are keyed by chunk id so they are
  **not** collapsed (page dedup would otherwise drop all but one window of a text file). The
  token budget always includes the single top chunk before enforcing `maxContextTokens`.
- **`[Sn]` labels assigned per query, never stored** (confirmed). Only the resolved
  `Citation[]` is persisted in `messages.citations_json`. **Retrieval is the source of truth
  for citations** — the mock runtime's echo has no real `[Sn]` markers, so computed citations
  are persisted directly (a real model emitting inline `[Sn]` still resolves against them).
- **`Citation.snippet` (additive):** `Citation` gained an optional `snippet` (truncated chunk
  text, ≤ `SNIPPET_MAX_CHARS` = 600) so the renderer's source panel shows the cited text and
  it survives reload via `citations_json`. Additive + optional → old rows are unaffected.
- **Grounding / empty-corpus copy:** when retrieval finds no usable chunks, the runtime is
  **not called**; a fixed `NO_DOCUMENT_CONTEXT_ANSWER` ("I couldn't find anything about that
  in your documents…") is persisted with no citations. Makes the no-hallucination guarantee
  deterministic + testable.
- **Grounded-prompt placement:** the grounded template (rules + question + numbered excerpts)
  replaces the **last user turn** sent to the runtime; the system message stays
  `BASE_SYSTEM_PROMPT`. The DB keeps the raw question (transcript/title).
- **Shared in-flight registry (`ipc/inflight.ts`):** chat + RAG share one
  `Map<conversationId, AbortController>` so the existing `stopGeneration` cancels either path.
- **Benchmark is strictly local (Phase 7):** `services/benchmark.ts` uses only `node:os` +
  `node:fs` + `node:crypto` — no `child_process`, no remote/GPU probes, no telemetry. A
  no-network assertion guards the whole path. Every probe is independently resilient: a
  failure yields a `null` value + a friendly warning, never a throw (a machine where
  everything fails still yields a valid `UNKNOWN` result).
- **Profile thresholds (spec §11.3, LOCKED):** RAM in **GiB** (`totalmem()/1024³`, rounded
  0.1); `≤8 → TINY`, `≤16 → LITE`, `≤32 → BALANCED`, else `PRO`; invalid RAM → `UNKNOWN`.
  **Downgrade rule:** `tokensPerSecond < VERY_LOW_TOKENS_PER_SECOND (3)` drops one step (never
  below TINY). **GPU rule:** a useful GPU bumps one step toward PRO (capped) — ~~GPU
  detection is best-effort `null` for now, dormant~~ **superseded by Phase 16**: the
  `--list-devices` probe feeds a precomputed `gpuUseful` hint (≥ 6144 MiB AND not
  integrated — `gpuUsefulForProfile`); `benchmark.ts` itself still never probes.
- **Drive-test bounds:** writes `DRIVE_PROBE_BYTES = 8 MB` of random bytes **inside the
  workspace**, times write (`fsync`) then read → MB/s; **always cleaned up** (`try/finally`);
  failure → `null` Mbps + `error`. **Slow-drive warning** at `< SLOW_DRIVE_MBPS (30)` MB/s —
  warn, never block.
- **Tokens/sec is optional in the mock era:** measured only when a runtime is active (prompt
  *"Write one sentence about privacy."*, up to 64 tokens); `null` otherwise. Real numbers land
  in Phase 10.
- **Benchmark persistence:** spec §8 has **no `benchmarks` table**, so the last result lives in
  the settings store as `AppSettings.lastBenchmark` (JSON `BenchmarkResult`, default `null`).
  **"Never benchmarked yet" default = `UNKNOWN`.** Both former stubs now read
  `lastBenchmark?.profile ?? 'UNKNOWN'`: `getAppStatus().hardwareProfile` and
  `buildModelList`'s `profile` (the `LITE` stub is gone). User-facing copy follows spec §11.4
  (never "your hardware is bad").
- **Policy shape + deny-by-default (Phase 8):** `services/policy.ts` models the spec §6
  `network`/`workspace`/`models` blocks as a camelCase `PrivacyPolicy`. `DEFAULT_POLICY` is
  **deny-by-default for network + telemetry** (both off); workspace/model defaults are
  developer-friendly (plaintext dev + unverified models allowed) since encryption enforcement is
  Phase 9 and model verification already gates on the `developerMode` setting. `config/policy.json`
  + `config/drive.json` are **optional**; missing/malformed → safe defaults **+ a warning, never a
  throw** (`bool()` only accepts real booleans, so junk fields can't weaken the policy).
- **Effective-network rule (LOCKED, Phase 8):** `networkAllowedByPolicy =
  allowModelDownloads || allowUpdateChecks`; `networkAllowed = networkAllowedByPolicy ∧
  user.allowNetwork`; `offlineMode = !networkAllowed`. A (future signed) policy is **authoritative**
  — it can only **restrict**, never expand, the user toggle. With no policy file the deny-by-default
  ceiling keeps the app offline even if `allowNetwork` is on (no network features ship before
  Phase 11 anyway). **Telemetry is always off** (no toggle, hardcoded `telemetryAllowed: false`).
- **`AppStatus.offlineMode` is now policy-aware** (was `!allowNetwork`); added
  `AppStatus.networkAllowed`. New `getPolicy` IPC (`policy:get`) returns `PolicyStatus` (effective
  policy + derived flags) so the UI distinguishes "off by choice" from "disabled by policy"
  (spec §3.6).
- **Loopback exception (LOCKED, Phase 8):** the offline self-check treats `127.0.0.0/8`, `::1`, and
  `localhost`/`*.localhost` as **not** network (dev renderer now; llama.cpp sidecar on 127.0.0.1 in
  Phase 10). Only remote origins are violations. `services/offlineGuard.ts`
  `installOfflineNetworkGuard` wraps `net.Socket.prototype.connect` and **only logs** a remote
  attempt — it never blocks or throws (a wrong host guess must not break local IPC/sidecar). The
  guard is installed in ALL builds when offline (an audit-round fix superseded the original
  dev-only gating); `assertOfflinePosture()` always logs the posture.
- **CSP dev-vs-prod split (Phase 8):** strict CSP applied as a response header
  (`session.webRequest.onHeadersReceived`) on top of the `index.html` meta tag. **Prod:**
  `default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. **Dev:** relaxes `connect-src` to `ws://localhost:* http://localhost:*`
  and adds `'unsafe-inline'`/`'unsafe-eval'` to **`script-src`** (+ `'unsafe-inline'` on `style-src`)
  for Vite HMR (a strict policy breaks `npm run dev`).
- **Logs-local guarantee (Phase 8):** confirmed `services/logging.ts` is the only log writer
  (rotating `app.log` under `logsPath`); nothing writes logs/crash data off-device. Stated as fact
  on the Privacy screen + PRIVACY.md.
- **KDF = Argon2id (default for new vaults), scrypt still supported (Phase 9 → audit round 2, R4):**
  NEW vaults derive the key with **Argon2id** (OWASP-recommended) via the pure-JS, audited
  **`@noble/hashes`** — no fragile native `argon2` build (the original R4 blocker). Default params
  `m=19456 KiB (19 MiB), t=2, p=1, keyLen=32` (~0.5 s/unlock). `node:crypto` **`scrypt`** is fully
  supported still (`SCRYPT_KDF` = `N=2^15, r=8, p=1`) so any vault created under the earlier scrypt
  default unlocks unchanged: the descriptor records `algo` + params and `deriveKey` dispatches on them
  — **no on-disk format change**. `KdfParams` fields are per-algo (`scrypt: N/r/p` · `argon2id: m/t/p`),
  validated in `deriveKey`. New dep: `@noble/hashes` (pure-JS, externalized like the parser libs).
- **Whole-DB-FILE encryption-at-rest (Phase 9, plan §4b):** `node:sqlite` has no SQLCipher, so the
  whole file is encrypted (AES-256-GCM, fresh 12-byte IV/encryption, 16-byte tag) — **the spec §8
  schema is identical in both modes**. At-rest artifact = `paid.sqlite.enc` (framed
  `MAGIC|iv|tag|ciphertext`). **On unlock:** verify password against an authenticated verifier (no
  DB touched) → decrypt `.enc` → `paid.sqlite` **on the drive** → `openDatabase`. **On lock/quit:**
  `PRAGMA wal_checkpoint(TRUNCATE)` + close → re-encrypt → `.enc` → **shred** the plaintext working
  file + `-wal`/`-shm`. The plaintext working copy on disk while unlocked is a **documented
  limitation**; secure-erase is **best-effort** on SSDs (wear-levelling).
- **Vault descriptor = unencrypted `config/workspace.json` (Phase 9):** settings (incl.
  `workspaceMode`) live INSIDE the encrypted DB, so the app can't read them pre-unlock. The
  descriptor `{ version, mode:'encrypted', kdf{algo,N,r,p,keyLen}, saltB64, verifier{iv,tag,ct} }` is
  the **only** pre-unlock artifact; it holds salt + KDF params + an AES-GCM **verifier** (known
  plaintext under the key) — **never** the password or key (both memory-only). Tests scan the
  descriptor + `.enc` and assert the password is absent.
- **Plaintext gating now ENFORCED (Phase 9):** `plaintextAllowed(policy, {isDev, developerMode})` —
  `workspace.encryptionRequired` is an absolute veto; `allowPlaintextDevMode` must be true; AND the
  caller must be a developer (dev build / developer mode). Pre-unlock `developerMode` is unreadable
  (in the encrypted DB) so `isDev` is the proxy. ⇒ a commercial build (not dev, encryptionRequired
  or no policy file) **defaults to encrypted** and onboarding never offers plaintext.
- **Lock-on-quit + Lock-now (Phase 9):** `WorkspaceController.lock()` runs on `will-quit` (alongside
  `runtime.stop()`) and from a sidebar **Lock now** button. `lock()` is a **no-op for plaintext_dev**
  (nothing to protect; closing it would wedge the app back into onboarding) — the plaintext DB just
  stays open until process exit. `db` on `AppContext` is a **getter** over the controller
  (`requireDb()` throws while locked), so all existing `ctx.db` call sites are unchanged and track
  unlock/lock at call time.
- **Sidecar discovery + env override (Phase 10):** `resolveLlamaServerPath(rootPath, platform, env)`
  finds `runtime/llama.cpp/<os>/llama-server[.exe]` (`win`/`mac`/`linux` sub-dirs, spec §6); a
  `PAID_LLAMA_BIN` env var overrides for dev. Pure `existsSync` — the "binary present?" check has no
  I/O surprises. `findFreePort()` picks a free **loopback** port (listen `127.0.0.1:0` → read → close;
  an inbound bind, not the outbound `connect` the offline guard watches).
- **Localhost-only binding (LOCKED, Phase 10):** every sidecar is spawned with `--host 127.0.0.1` and
  every fetch targets `http://127.0.0.1:<port>`. **Never** `0.0.0.0`/a routable interface. The Phase-8
  offline guard exempts loopback for exactly this; the no-network assertions assume loopback-only. A
  unit test asserts the spawn args + fetch URLs are `127.0.0.1`, never `0.0.0.0`.
- **OpenAI-compatible streaming endpoint (Phase 10):** `LlamaRuntime.chatStream` POSTs to
  `/v1/chat/completions` with `stream:true`, sending `messages` as plain role/content (**the server
  applies the model's chat template** — we never hand-roll Qwen's prompt format) and mapping
  `maxTokens`/`temperature`. `readChatSSE` parses `data:` frames (partial-line buffering, ignore
  keep-alives, stop on `[DONE]`), `yield`s each delta, honours `options.signal`. Feeds the **locked
  Phase-3 streaming contract** unchanged ⇒ `measureTokensPerSecond` reports **real** tokens/sec once a
  real runtime streams.
- **Real-embedder backend = `llama-server --embedding` (Phase 10, R6):** `E5Embedder` composes the
  **same** prebuilt `llama-server` binary (`--embedding --pooling mean`) over loopback `/v1/embeddings`.
  Chosen over ONNX (onnxruntime-node + tokenizer = a heavier **native** add) because it adds **zero new
  npm deps** and no fragile native build — consistent with the `node:sqlite`/pure-JS theme. **Lazy-
  started on first `embed()`** and reused; an additive optional `Embedder.stop()` kills it (wired into
  `will-quit`). Same **id (manifest) + 384 dims + L2-normalized** output ⇒ drop-in behind the
  `Embedder` interface; the locked Float32 BLOB encoding + `VectorIndex` are unchanged.
- **Embedding-model-mismatch handling = filter by id (LOCKED, Phase 10):** mock (`mock-embedder`) and
  real E5 vectors are **both 384-dim**, so the dimension guard can't separate them — mixing them
  silently corrupts ranking. `VectorIndex` takes an optional `{ embeddingModelId }` that scopes the
  cosine scan to `WHERE embedding_model_id = ?`; `rag.retrieve` passes the **active embedder's id**.
  Chosen over a forced reindex-on-switch (cheaper, no re-embed pass; a reindex still re-embeds with the
  active model). Default (no id) scans all rows ⇒ existing callers/tests unchanged. A test proves a
  mock↔real switch can't blend vector spaces.
- **Script logic in a tested TS module + self-contained shell scripts (Phase 11):** the canonical
  layout/config/checksum logic lives in `services/drive.ts` and is unit-tested by vitest; the
  `scripts/*.{ps1,sh}` **re-implement the same plan natively** rather than shelling out to Node.
  Rationale: a drive must be preparable on a **fresh machine with no Node/npm** (and no TS runner is
  installed — tsx/ts-node absent), and tests must run in CI without PowerShell/bash. `drive.ts` is the
  documented source of truth; the small drift surface (dir list + JSON shapes) is cross-checked (the
  PS + bash + TS emit **semantically-equivalent** config — valid JSON the app parses identically).
  ⚠️ Not literally byte-identical: timestamps differ per run, and `ConvertTo-Json` whitespace differs
  from the bash here-docs. The PS scripts now write **UTF-8 without a BOM** (`Set-Content -Encoding
  UTF8` on PS 5.1 would emit a BOM that breaks Node's `JSON.parse`) — audit fix.
- **Drive-layout naming reconciliation (LOCKED, Phase 11):** the prepared-drive dirs follow the
  **code**, not the spec's prose. Sidecar OS sub-dirs are **`win`/`mac`/`linux`** (`sidecar.ts`
  `llamaOsDir`), and manifests live in a **top-level `model-manifests/`** (`models.ts`
  `resolveManifestsDir`) — NOT `windows/macos/linux` or `models/manifests/`. `drive.ts`
  `DRIVE_LAYOUT_DIRS` is canonical; `docs/drive-layout.md` was corrected to match.
- **Config-generator defaults (Phase 11):** `prepare-drive` writes `config/drive.json` (the
  prepared-drive marker `resolvePaths` keys off) + `config/policy.json`. **Network is ALWAYS
  deny-by-default** (the offline guarantee — `resolveNetwork` is policy ∧ user setting). The default
  posture is **commercial** (spec §6 example: encryption required, no plaintext, models must verify);
  a `-Dev`/`--dev` flag flips to a developer-friendly drive (plaintext + unverified allowed) but
  **still denies network**. JSON shapes are exactly what `parsePolicy`/`mergePolicyObject` accept
  (snake_case booleans). Files are written onto the **drive**, never committed.
- **checksums.json shape (Phase 11):** `{ drive_format_version, generated_at, algorithm:'sha256',
  entries:[{ id, local_path, sha256|null, size_bytes|null, present }] }`. Written by `verify-models
  --generate` from the weights present on the drive. **Informational** — the app still verifies
  against the manifest `sha256`; checksums.json records what a drive builder captured. Placeholder
  manifest hashes report **UNVERIFIED** (not pass, not fail), mirroring `computeInstallState`'s
  developer-mode gate (R5 checksum honesty).
- **Portable Windows target via electron-builder (Phase 11):** `electron-builder.yml` defines a
  `portable` Windows `.exe` (launch-from-drive) + `mac`(dir)/`linux`(AppImage) for parity.
  `model-manifests/` ship as `extraResources` (found via `resolveManifestsDir(app.getAppPath())` →
  `resources/model-manifests`; `PAID_MANIFESTS_DIR` overrides); prod deps (the externalized parser
  libs) ship inside `app.asar`; Electron stays **≥37** so `node:sqlite` exists. `npm run package` /
  `package:win` wired. **Building the real artifact is a MANUAL step** (R2 Electron download; npm
  workspace dep-hoisting may need attention) — it is NOT part of the green gate.
- **Graceful-fallback rule (LOCKED, Phase 10):** the real backends are **opt-in by availability**.
  `createSelectingRuntimeFactory` (per `start()`, when the model path is known) and
  `createSelectedEmbedder` return the real `LlamaRuntime`/`E5Embedder` **only when BOTH** the
  `llama-server` binary **and** the GGUF weights exist; else the mock. ⇒ the app launches and the whole
  suite passes with **zero model files** (the repo/CI default). The embedder reads its model from the
  **manifest** (settings live in the possibly-encrypted DB, unreadable pre-unlock).
- **Optional manifest `download` block (Phase 12, additive):** `shared/manifest.ts` gained an
  **optional** `download: { url, sha256, size_bytes?, license_url? }` validated **only when present**,
  so every existing manifest stays valid. A **real** `download.sha256` must equal a **real** top-level
  `sha256` (same file); placeholders pass through. The four committed model manifests now carry real
  upstream URLs (Qwen3 GGUF + multilingual-E5) with `sha256` left as the `REPLACE_WITH_REAL_HASH`
  placeholder (a placeholder = "fetch then capture via `verify-models --generate`"). The legacy
  `download_url: null` field was removed.
- **`runtime-sources.yaml` (Phase 12):** the `llama-server` sidecar is NOT a model, so it gets a
  committed `model-manifests/runtime-sources.yaml` (`llama_cpp: { version, builds:[{os,arch,backend,
  url,sha256,extract_to}] }`) validated by `shared/runtime-sources.ts` (`validateRuntimeSources`,
  mirroring `validateManifest`). **Excluded from model discovery** via `RESERVED_MANIFEST_FILES` in
  `models.ts` (it would fail `validateManifest`). **Default backend = CPU** (AVX2 win/x64, Metal
  mac/arm64, plain CPU linux/x64) — broadest-compatible for an unknown laptop; GPU is an opt-in
  `--backend` override. `selectRuntimeBuild` returns the **first** os/arch match when no backend is
  given (the CPU build is listed first per OS).
- **Build-time network ≠ runtime network (LOCKED, Phase 12):** the `fetch-*` scripts make the
  project's first deliberate network access, but run on the **drive-builder's online machine at build
  time, NOT in the app at runtime**. The app stays 100% offline by default; the optional in-app
  downloader (plan §12.3) stays policy-gated (`network.allow_model_downloads`, deny-by-default) **and**
  behind the user `allowNetwork` setting. The offline guarantee is unchanged. The in-app downloader
  was **DEFERRED** (not required for the DIY acceptance criteria).
- **Verify-before-trust + license gate (LOCKED, Phase 12):** every downloaded artifact is
  SHA-256-verified **before** it counts as installed — a real-hash mismatch deletes the partial and
  exits non-zero; a **placeholder** expected hash downloads but reports *UNVERIFIED* (never a silent
  pass). The license gate refuses to plan/fetch a model whose `license_review.status != approved`
  unless `--accept-license`/`-AcceptLicense` is set (license + `license_url` printed first). Downloads
  are **resumable** (`curl -C -` / `aria2c`) and **idempotent** (present + verified → skip fast).
- **`services/assets.ts` is the canonical asset-loader logic (Phase 12):** mirrors `drive.ts` — the
  scripts re-implement the same plan natively (self-contained, no Node/npm). Pure/testable:
  `planModelDownloads` (fs reads, NO network), `selectRuntimeBuild`, `planRuntimeDownload`
  (escape-guarded paths reusing `weightPath` semantics), `verifyDownloadedFile`, and an injected-fetch
  `downloadToFile`/`fetchAndVerify` seam (the network seam a future §12.3 downloader reuses; tests
  drive it with a fake `fetch` so the **no-network assertion holds**). The scripts' `.ps1` files are
  **pure ASCII** (Windows PowerShell 5.1 reads non-BOM scripts in the ANSI codepage; a UTF-8 em-dash's
  `0x94` byte decodes to `"` and breaks a double-quoted string — same class of bug as the Phase-11
  BOM issue).
- **Launcher resolves the drive root from its OWN location (LOCKED, Phase 13):** the per-OS launcher
  (`Start Private AI Drive.{cmd,command}` / `start-private-ai-drive.sh`) sets `PAID_DRIVE_ROOT` from
  where it sits (`%~dp0` / `dirname "$0"`), **never** a hardcoded drive letter — drive letters/mounts
  change per machine, and the same drive must continue the **same encrypted workspace** on a second
  laptop (success criterion #10; `resolvePaths` already redirects all state onto the drive). Canonical,
  unit-tested resolver = `services/launcher.ts` `resolveDriveRootFromLauncher(launcherPath, flavor?)`
  (handles Windows drive-letter + POSIX paths, rejects empty/relative). The launcher scripts mirror it.
  **Autorun is dead** (Windows disabled `autorun.inf` from removable drives) — the app cannot
  auto-launch on plug-in and must not try; the drive opens a window and the buyer double-clicks the
  well-named launcher (+ a root `READ ME FIRST.txt`).
- **Signing/notarization is a documented MANUAL step; the green gate never signs (LOCKED, Phase 13):**
  `electron-builder.yml` wires `win.signtoolOptions` + `mac.notarize`/`hardenedRuntime` +
  `build/entitlements.mac.plist`, but ALL secrets come from **env vars / a git-ignored secrets file on
  the build machine** (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; `CSC_LINK`/`APPLE_ID`/
  `APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) and **never enter the repo** (`.gitignore` excludes
  `*.pfx`/`*.p12`/`*.cer`/`*.key`/`signing.env`/`*.provisionprofile`). The green gate
  (`typecheck`/`test`/`build`) does not invoke electron-builder, so signing is off the critical path
  (like the R2 Electron download). EV (Windows) builds SmartScreen reputation fastest; macOS without
  notarization is quarantined. The unsigned DIY "Run anyway" / right-click→Open fallback stays in
  `docs/troubleshooting.md`. New procurement risk **R7** (cert cost/lead-time) blocks only the
  *commercial* acceptance.
- **`build-commercial-drive` = plan + final posture assertion, mirrored by scripts (LOCKED, Phase 13):**
  `services/commercial-drive.ts` is the canonical, unit-tested reference (like `drive.ts`/`assets.ts`):
  `planCommercialDrive(opts) → CommercialStep[]` + `formatPlan` (the ordered steps: prepare → fetch-
  models → fetch-runtime → **package/sign [manual]** → copy launcher+app+docs → verify-models --generate
  → assert) and `assertCommercialDrive(root, manifests) → { ok, problems[], checks, modelResults }`
  which **reuses `loadPolicy` + `verifyDriveModels`** to assert the **commercial posture** (encryption
  required, plaintext off, models must verify, **network denied**) + **every weight VERIFIED** + **no
  user data present** (spec §12.2 — fails loudly otherwise). `scripts/build-commercial-drive.{ps1,sh}`
  orchestrate the existing Phase-11/12 scripts (NOT re-implementing them) + a native cross-check of the
  same invariants. ⚠️ PS gotcha fixed: invoke sibling scripts via **hashtable** splatting
  (`& $path @{Target=…}`), not array splatting (array splat binds positionally → `-Target` is rejected);
  reset `$global:LASTEXITCODE = 0` before each call so a stale code isn't misread.
- **Launch preflight reuses the benchmark; non-blocking (LOCKED, Phase 13):** `services/preflight.ts`
  `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) → PreflightResult` reuses
  `buildDriveStatus` (writable + free space) + `measureDriveSpeed`/`buildWarnings` (the spec §11.4
  slow-drive copy) — it does NOT add a second drive probe. Friendly + **non-blocking** (read-only / low
  space → `problems[]`, slow drive → `slowDriveWarning`; never "bad hardware", never blocks). The
  drive-speed fn is **injected** in tests (deterministic, no real I/O, no network). Surfaced on Home via
  the `preflight:run` IPC (`registerCoreIpc`, preload `api.runPreflight`). **Encrypted-by-default kept:**
  the commercial first-run still lands on the existing `WorkspaceGate` (no plaintext offered when the
  policy forbids it); only the copy was softened for zero-technical-knowledge users.

- **Vulkan-first runtime distribution (LOCKED, Phase 14 — gpu-support-plan §1 decisions are FINAL):**
  `runtime-sources.yaml` now lists the **Vulkan full build first** per win/linux (b9585 vulkan assets,
  hashes re-verified from fresh downloads on 2026-06-10) extracting to `runtime/llama.cpp/<os>/`, plus
  the **pure-CPU safety net** (the former defaults) at `runtime/llama.cpp/<os>/cpu/`; mac stays
  Metal-only. Safe-as-default because the upstream Vulkan archives are **standalone full builds**
  carrying every CPU backend variant (GGML_BACKEND_DL) — on a GPU-less machine the same binary runs on
  its bundled CPU backends. `selectRuntimeBuild`'s "first match wins" is unchanged (now vulkan-first);
  new `selectRuntimeBuilds` (plural) returns every build an OS ships for the commercial pipeline.
  `validateRuntimeSources` rejects duplicate `(os, arch, backend)` triples. **No new licenses**: both
  vulkan archives build from the same MIT llama.cpp tag already approved (the Vulkan loader is NOT
  redistributed — it ships with the user's GPU driver).
- **Runtime install marker `.paid-runtime.json` (LOCKED, Phase 14):** after a verified extraction,
  `fetch-runtime.{ps1,sh}` write `{ version, backend, os, arch }` (flat single-line JSON, UTF-8 no BOM)
  into the build's extract dir. **Idempotent skips are marker-based** (version + backend must match) —
  mere binary presence is no longer trusted, fixing the upgrade hole where a CPU-era drive would
  silently keep its CPU build after the default moved to vulkan. Canonical logic in `assets.ts`
  (`RUNTIME_MARKER_FILE`, `read/writeRuntimeMarker`, `runtimeInstallCurrent`); the scripts mirror it.
  `assertCommercialDrive` gained an optional `runtimeSources` param + `checks.runtimeCurrent` (each
  pinned build's marker must match version + backend); `build-commercial-drive.{ps1,sh}` fetch BOTH
  builds per win/linux (default + `-Backend cpu`) and cross-check the five markers natively in step 7.
  The fetch scripts' flatten step now **excludes the `cpu/` subdir** from the binary search (the
  safety net must not be mistaken for the freshly extracted nested default binary).
- **GPU start ladder + probe (LOCKED, Phase 15 — gpu-support-plan §5):** the selecting factory now
  returns a **ladder runtime** when binary + weights exist: rung 1 = default binary, default args
  (b9585 `-ngl auto` + `--fit on` auto-offload — **we never pass `-ngl`**; on a GPU-less machine
  rung 1 IS CPU mode) → rung 2 = same binary + **`--device none`** (the only CPU-forcing mechanism)
  → rung 3 = `runtime/llama.cpp/<os>/cpu/` safety net (`resolveCpuFallbackServerPath`) → rung 4 =
  MockRuntime (existing graceful-fallback rule — never stuck). `gpuMode:'off'`/`gpuAutoDisabled`
  skip rung 1; a rung-1 failure persists `gpuAutoDisabled` + `gpuLastError` (no repeated 60 s GPU
  timeouts). `services/runtime/gpu.ts`: `probeGpuDevices` (subprocess `--list-devices`, **10 s**
  kill-timeout — the plan's 3 s sketch was raised after a cold Vulkan init exceeded it, see plan
  §13 deviation 1; resolves on the child's **`close`** event so late-buffered stdout is never
  truncated; never throws → `[]`), pure `parseListDevices`, `looksIntegrated` heuristic,
  `createCachedGpuProbe` (once per binary per session; `invalidate()` re-probes — wired to
  "Try GPU again"). The probe runs CONCURRENTLY with the rung-1 server start (never serially
  after it) and only LABELS the backend (`RuntimeStatus.backend: 'gpu'|'cpu'|'mock'` +
  `gpuName`); the ladder is the guarantee. GPU deps are injected callbacks (never DB reads
  inside the factory); `main/index.ts` wires them with locked-DB-safe guards (sidecars only
  start post-unlock anyway).
- **Mid-generation crash auto-fallback (Phase 15, §5.3):** `LlamaServer.onUnexpectedExit` fires
  only for a HEALTHY server dying outside `stop()` (start failures still throw; stop exits are
  expected). When the active backend was GPU, `createGpuCrashAutoFallback` (re-entrancy-guarded)
  persists the flags, restarts the same model ONCE at CPU via the manager, and broadcasts the
  friendly notice over the new **`runtime:notice` event channel** (preload `api.onRuntimeNotice`):
  `COMPATIBILITY_MODE_NOTICE` — §11.4 tone, never "GPU failed". CPU-backend crashes keep today's
  behavior. **E5 embedder pinned to CPU** (`--device none` appended to its extraArgs, §7).
- **New `AppSettings` keys (Phase 15):** `gpuMode: 'auto'|'off'` (default `'auto'` — GPU is always
  the default, decision Q2), `gpuAutoDisabled: boolean`, `gpuLastError: string|null`,
  `gpuProbe: GpuProbeResult|null` (cached devices + timestamp; persisted by the Phase-16 benchmark
  path). `GpuDevice`/`GpuProbeResult` live in `shared/types.ts`.
- **Manual GPU smoke harness:** `tests/manual/gpu-smoke.test.ts` — skipped unless `PAID_GPU_SMOKE`
  points at a provisioned drive root (CI stays zero-GPU/zero-binary). On the dev box it exercises
  the real probe, a real rung-1 GPU start + streamed tokens, `gpuMode:'off'`, and a stubbed rung-1
  failure landing on the real rung-3 safety net.
- **Conservative GPU profile bump (LOCKED, Phase 16 — gpu-support-plan §8):** `classifyProfile`'s
  hint is now `gpuUseful?: boolean` (the dormant "any truthy gpu string bumps" branch was NOT woken
  as-is). Eligibility = `gpuUsefulForProfile(devices)` in `runtime/gpu.ts`: some probed device has
  **≥ 6144 MiB** (`GPU_BUMP_MIN_VRAM_MB`) AND `!looksIntegrated(name)` — an Iris Xe reporting 16 GB
  of shared RAM must never push a laptop a profile step up. `benchmark.ts` keeps **zero
  `child_process`**: the IPC layer (`registerBenchmarkIpc.probeAndPersistGpu`) runs the
  session-cached probe (`AppContext.probeGpu`), persists `settings.gpuProbe`, and **injects**
  `RunBenchmarkDeps.gpu: { name, useful }`; `BenchmarkResult.gpu` carries the probed name
  (additive — old persisted results stay valid).
- **GPU surface (Phase 16):** Settings gained the "Use GPU acceleration" toggle (default ON,
  binds `gpuMode 'auto'|'off'` — decision Q2 copy); Diagnostics gained the **Acceleration** line
  (live `RuntimeStatus.backend`/`gpuName` when running, else the cached `gpuProbe`; mock reads
  "Built-in demo runtime"), the **runtime build** line (new `getRuntimeInstall` IPC
  `runtime:install` → the Phase-14 `.paid-runtime.json` marker via `readRuntimeMarker`; null on
  manually provisioned drives), and the `gpuAutoDisabled` notice + **"Try GPU again"** button
  (clears `gpuAutoDisabled`+`gpuLastError` — does NOT touch the
  toggle). `App.tsx` shows the dismissible `runtime:notice` banner (the §5.3 compatibility-mode
  copy). All copy follows spec §11.4 — "compatibility mode", never "GPU failed".
- **GPU audit round (2026-06-10, post-Phase-16 — all findings remediated; commit `4549934`):**
  1. **fetch-runtime upgrade bug (HIGH):** re-fetching over an existing install (the exact
     cpu→vulkan upgrade path the Phase-14 marker exists for) never re-flattened the nesting
     mac/linux tarballs — the OLD root binary survived while the fresh marker claimed vulkan.
     Both scripts now **pre-clean the extract dir before extraction** (everything except the
     just-downloaded archive + the `cpu/` safety net); a stale marker dies with the old build.
  2. **Sell gate hardened:** `assertCommercialDrive` + the native step-7 checks now require the
     **binary** (not just a marker), the native checks verify **backend** (not only version),
     and `extract_to` is escape-guarded via `planRuntimeDownload`.
  3. **Probe correctness:** resolves on the child's `close` (not `exit` — a truncated-stdout
     race could yield a false-empty device list); `createCachedGpuProbe` gained `invalidate()`;
     the rung-1 probe runs **concurrently** with the server start (no serial 10 s stall on a
     cold cache, smaller crash-mislabel window).
  4. **"Try GPU again" is a dedicated IPC (`gpu:try-again`)**: clears the flags AND invalidates
     the session probe cache AND re-probes + persists — a plain settings write kept a stale
     "no GPU" probe cached for the whole session. Diagnostics hides the button when the
     Settings toggle is OFF (it would silently do nothing) and points at Settings instead;
     "Run benchmark" now refreshes the Acceleration line.
  5. **`gpuProbe` persistence is per-session**, not benchmark-only: `maybeRunFirstBenchmark`
     refreshes it in the background even when a benchmark exists (a drive moved between
     machines kept showing the previous machine's GPU; pre-GPU workspaces never got one).
  6. **`looksIntegrated` broadened** for real driver strings: RADV APUs ("AMD Radeon Graphics
     (RADV REMBRANDT)"), Windows APU names ("AMD Radeon(TM) 780M Graphics"), Meteor-Lake
     "Intel(R) Arc(TM) Graphics" — discrete Arc "A###"-series still bumps. Fixture-tested.
  7. Small: `gpuMode` is enum-guarded in `updateSettings`; `fetch-runtime.ps1` is pure ASCII
     again; stale "(CPU) default" docstrings fixed.
- **Post-MVP UX polish round (2026-06-10)** — four user-reported issues, all behind existing
  contracts (tests in `chat-ipc`, `core-model-ipc`, `models`, `tests/renderer/ChatHomeNav`):
  1. **Conversation deletion:** `deleteConversation` (`chat:deleteConversation`) removes a
     conversation — chat AND documents mode — plus its messages (messages first; the FK has no
     CASCADE). Refused while a stream is in flight for that conversation (the persisted assistant
     turn would resurrect/FK-violate after the delete). UI: a ✕ per sidebar row with a confirm.
  2. **Persisted checksum cache:** the H5 in-memory cache died with the session, so the FIRST
     Models/Chat visit after every launch still re-hashed multi-GB GGUFs with no feedback. New
     `AppSettings.checksumCache` (`path → {size, mtimeMs, sha256}`, default `{}`) is the L2
     behind the in-memory L1 — `HashStore` is injected (`createSettingsHashStore(db)`) through
     `verifyChecksum`/`computeInstallState`/`buildModelList`, so an unchanged weight is hashed
     **once ever**; size/mtime changes re-hash. Living in settings (lastBenchmark precedent — no
     schema change) it is encrypted at rest on encrypted workspaces. **"Verify checksum" is now a
     true re-verify** via the new `verifyModel` IPC (`models:verify`): `invalidateChecksum`
     (memory + store) then a fresh `computeInstallState`. Models screen got a spinner +
     first-check copy; the accepted same-size/mtime-tamper limitation is recorded in
     `docs/known-limitations.md`.
  3. **Active-model auto-start:** a restarted app showed an "active" model whose runtime wasn't
     running. The `startRuntime` handler's §7.4 gate logic moved to an exported
     `startModelRuntime(ctx, modelId)`; new `maybeAutoStartActiveModel(ctx)` (mirrors
     `maybeRunFirstBenchmark` — background, never throws/blocks) fires at startup (plaintext dev)
     and after unlock/create (encrypted). Opt-out: `AppSettings.autoStartActiveModel` (default
     `true`) + a Settings toggle. ChatScreen's "no model" empty state now polls
     `getRuntimeStatus` every 2.5 s (and says the model may still be loading) so it flips to the
     composer by itself; its runtime check uses `getRuntimeStatus` instead of `listModels`
     (cheaper, no hashing).
  4. **Home navigation fix:** "Ask My Documents" used to land on the import screen. App.tsx now
     has a central `navigate()` with a virtual `'ask-documents'` target → Chat screen with
     `initialMode='documents'` (new optional `ChatScreen` prop); sidebar "Chat" resets to chat
     mode.
- **Post-MVP UX polish round 2 (2026-06-10):**
  1. **Chat output renders Markdown:** assistant replies (persisted AND the live streaming
     bubble) render GFM via **`react-markdown` + `remark-gfm`** (new RENDERER deps — pure JS,
     MIT, bundled by Vite into the renderer; NOT main-process/externalized). Safe by
     construction: react-markdown builds React elements (no `innerHTML`) and raw HTML in model
     output renders as **literal text** (renderer test proves no `<img>` injection). Links get
     `target="_blank"` → the existing window-open handler (http/https → OS browser, else deny).
     **User turns stay plain text** (`.msg-content` pre-wrap); assistant bubbles use
     `.msg-content.md` (white-space normal + scoped element styles in styles.css).
  2. **"Lock now" stops the sidecars:** `lockWorkspace` now aborts all in-flight generations
     (`inFlightStreams`), `Promise.allSettled`-stops the chat runtime AND the E5 embedder (a
     llama-server holds recent prompts in its KV cache), THEN `workspace.lock()` — a wedged
     sidecar never blocks the re-encrypt. Unlock restarts the chat runtime via the existing
     `maybeAutoStartActiveModel`; the embedder restarts lazily on next `embed()`.
- **Post-MVP UX polish round 3 (2026-06-10):**
  1. **RAM gate + RAM-best-fit recommendation:** `machineRamGb()` (totalmem, **whole-GB
     `Math.round`** so a "16 GB" machine reading 15.9 GiB still counts as 16) feeds
     `buildModelList` → new `ModelInfo.insufficientRam` (min RAM > machine RAM). UI: a
     "Needs ≥N GB RAM" badge + disabled Select/Start (§11.4 copy: "pick a smaller model —
     quality stays great"); MAIN gate: `startModelRuntime` refuses to load INSTALLED weights
     that don't fit (mock fallback ungated — uses no real RAM). **Recommendation is now
     RAM-best-fit** (`recommendModelIdByRam`): largest model whose `recommended_ram_gb` fits,
     else lightest meeting its minimum, else none — used by `listModels` AND the benchmark
     (same whole-GB rounding ⇒ the surfaces can never disagree); profile-table lookup stays
     as the no-RAM fallback. `AppStatus.machineRamGb` added (badge copy).
  2. **Read-only in-app document preview:** new `extractDocumentPreview` + `previewDocument`
     IPC (`docs:preview`) + a Documents-screen modal. RE-PARSES the stored copy (chunks
     overlap ~80 tokens — concatenating them duplicates boundary text); falls back to the
     original file if the copy is gone. Encrypted workspaces decrypt to a transient
     `.parse-preview` file shredded on the way out (the `.parse` infix keeps it under the
     startup crash sweep); without a cipher an `.enc` copy is refused. Deliberately TEXT-only
     (never `shell.openPath`): the original bytes must never reach an external viewer in
     plaintext. Tested: ingestion + encrypted-leak tests + renderer modal tests.
- **Doc lifecycle: finished plans become design records (2026-06-10):** implemented plan docs
  are condensed to short design records (decisions + load-bearing facts + the design as built)
  or deleted, with the full original in git history — finished plans otherwise drift and
  contradict code (the GPU audit proved it). Applied: `docs/IMPLEMENTATION_PLAN.md` **deleted**
  (per-phase ritual lives in CLAUDE.md; spec-§22 Definition of Done folded into §5; the dead
  Phase-0 `PlaceholderScreen.tsx` went with it); `docs/gpu-support-plan.md` and
  `docs/provisioning-and-distribution-plan.md` **condensed** with their cited section anchors
  kept stable (gpu §1–§8; provisioning §0/§12/§12.3/§13). Rule recorded in CLAUDE.md
  ("Doc lifecycle rule"). Full originals: `git show 4549934:docs/<file>`.
- **Phase 17 — RAG trust & document-scoped asking (2026-06-10, plan
  [`docs/post-mvp-functionality-plan.md`](docs/post-mvp-functionality-plan.md) §5; design
  record in `docs/rag-design.md` §10):**
  1. **"Ask selected documents" (spec §10.4):** `VectorIndexOptions.documentIds` scopes the
     cosine scan (placeholder SQL, composes with the Phase-10 model-id filter); the scope
     **persists on the conversation** (additive nullable `conversations.scope_json`, guarded
     `ALTER TABLE` in `db.ts` — decision D2a; malformed JSON reads back null, never throws).
     `createConversation` accepts it, `updateConversationScope` (`chat:updateScope`)
     replaces/clears it, `askDocuments` reads it from the conversation (**deviation:** no
     per-call `documentIds` arg — redundant once persisted). UI: Documents-screen checkboxes
     (indexed only) + "Ask these documents (N)" → Chat with removable scope chips; the
     pending handoff applies to the next documents conversation created.
  2. **Plain-chat document awareness (§5.1):** with ≥1 indexed document, plain Chat shows a
     dismissible per-conversation notice + one-click "Ask Documents instead" (the wrong-tab
     hallucination guard from the §9 drive test); mode tabs gained subtitles. Renderer-only.
  3. **Vector-tag rule (LOCKED):** ingestion tags vectors with the id of the embedder that
     ACTUALLY produced them (`embedder.id` fallback; `registerDocsIpc` no longer passes
     `settings.activeEmbeddingModelId`). The old tag could stamp mock-produced vectors with
     the E5 manifest id — invisible to mock-scoped search now, poisoning E5-scoped search
     later. Tag and search scope must come from the same place. (Stronger fix than the
     plan's "persist `activeEmbeddingModelId`"; plan §5.5 deviation 1.)
  4. **`REINDEX_NEEDED_ANSWER` (§5.2):** when retrieval is empty AND `corpusNeedsReindex`
     (indexed chunks exist but no document has vectors under the active embedder), the fixed
     answer says "re-index", not "rephrase" — still never calls the model. Documents screen
     gained **Re-index all** (sequential) next to the existing per-doc stale badge.
  Tests: `tests/integration/rag-scope.test.ts` (incl. the pre-Phase-17 column migration) +
  chat-ipc + renderer (ChatHomeNav, DocumentsScreen). Gate: typecheck clean, 499 tests, build
  green.
- **Phase 18 — in-app model downloader (2026-06-10, plan
  [`docs/post-mvp-functionality-plan.md`](docs/post-mvp-functionality-plan.md) §6; the revived
  plan §12.3):**
  1. **D3 RESOLVED (a) — `DEFAULT_POLICY.network.allowModelDownloads` is now `true`:** with no
     policy file, the spec §3.6 user Settings toggle ("Allow internet access for model
     downloads…", **default OFF**) is the effective downloads gate. Update checks + telemetry
     stay denied with no toggle. `prepare-drive` keeps writing `allow_model_downloads: false`
     in BOTH postures, so prepared drives stay download-disabled unless the builder edits
     `config/policy.json` — the "policy only restricts, never expands" rule is preserved
     verbatim (the default is the ceiling when no file restricts it).
  2. **Triple gate, enforced in MAIN (plan §6.1):** policy ceiling ∧ `settings.allowNetwork`
     (locked workspace ⇒ treated as off) ∧ a per-download confirmation (size, license +
     `license_url`, upstream URL, and an explicit license-acknowledgement checkbox when
     `license_review.status != approved` — the in-app `--accept-license`). `downloadModel`
     re-checks gates 1–2 on every call; the renderer dialog is UX, not enforcement. The Models
     screen explains WHY downloads are unavailable (policy vs. Settings) via the existing
     `PolicyStatus` distinction.
  3. **`services/downloads.ts` `DownloadManager`** — a job state machine over the REUSED
     `assets.ts` seams (`planModelDownloads` with a new optional `hashStore`, `downloadToFile`,
     `verifyDownloadedFile`): bytes land in `<weightPath>.part`, renamed into place ONLY after
     the hash verifies; a mismatch deletes the partial + fails the job; a placeholder expected
     hash completes but flags the job `unverified` (checksum honesty, R5). Cancel keeps the
     `.part`; the next start resumes via a `Range` header (206 appends, a 200 restarts cleanly
     — `downloadToFile` only appends when the server actually honoured the Range). On success
     the path's checksum-cache entry is invalidated. **One download at a time.** Jobs are
     in-memory (the Phase-4 import-job precedent).
  4. **`downloadToFile` seam extended (additive):** `DownloadDeps` gained `signal`, `headers`,
     `append` (append iff 206), `onResponse({status, contentLength})`; it now returns
     `{ status, received, contentLength }`. On a stream error the write side is `end()`ed (not
     destroyed) so the received prefix flushes — it IS the resume prefix. Existing callers
     (`fetchAndVerify`, scripts' planning) are unchanged.
  5. **IPC = async-with-polling, no new event channels:** `downloadModel(modelId,
     {licenseAccepted?})` → `DownloadJob`, `getDownloadJob(jobId)`, `cancelDownload(jobId)`
     (`downloads:start/get/cancel`) in `ipc/registerDownloadIpc.ts`; production injects the
     global `fetch`, tests inject a fake (CI stays zero-network — the gate tests prove a closed
     gate never reaches the fetch seam). `ModelInfo` gained an optional `download`
     (`ModelDownloadInfo { url, sizeBytes, licenseUrl, licenseApproved }`) so the renderer can
     populate the confirmation without a fourth IPC.
  6. **Offline guarantee unchanged:** no update checks, no catalog, no background anything; a
     sanctioned download session is by definition not `offlineMode`, so the offline guard/CSP
     posture stays as-is (accepted cosmetic edge in `known-limitations.md`: the startup-installed
     detection-only tripwire logs a notice if the toggle is flipped and a download runs in the
     same session).
  Tests: `tests/integration/downloads.test.ts` (14) + `download-ipc.test.ts` (6) +
  `tests/renderer/ModelsScreen.test.tsx` (6) + updated `policy.test.ts` for the new default.
  Gate: typecheck clean, 525 tests, build green.
- **Phase 19 — audit log on `runtime_events` (2026-06-10, plan
  [`docs/post-mvp-functionality-plan.md`](docs/post-mvp-functionality-plan.md) §7, deviations
  in §7.1; data class in `docs/security-model.md`):** the spec §8 table (created in Phase 1,
  written by nothing) finally gets its writer — the first Office/Enterprise compliance
  feature. **FOR THE USER, not telemetry**: lives in the workspace DB (encrypted at rest on
  encrypted workspaces), local only, nothing uploads (spec §7.11). No schema change.
  1. **`services/audit.ts`:** `recordEvent(db, type, message, metadata?)` **never throws**
     (returns false on any failure); typed `AuditEventType` union in `shared/types.ts`
     (runtime_started/stopped/crashed/fallback, model_selected/verified,
     model_download_started/verified/failed, document_imported/reindexed/deleted,
     conversation_deleted/exported, workspace_created/unlocked/locked/unlock_failed,
     settings_changed, policy_warning, offline_guard_violation); `listAuditEvents`
     (newest-first by `created_at DESC, rowid DESC`, `beforeId` cursor); **retention =
     prune-on-insert to `AUDIT_MAX_ROWS` = 5 000** (decision D7 RESOLVED: fixed for wave 1).
     `createAuditRecorder(getDb)` → optional **`AppContext.audit`** (`ctx.audit?.(…)`):
     buffers events in memory (bounded 100) while `ctx.db` throws (locked vault) and flushes
     them, original timestamps kept, on the next successful write — how
     `workspace_unlock_failed` ever reaches the encrypted log.
  2. **PRIVACY RULE (hard, sentinel-grep-tested):** rows carry ids, model ids, filenames,
     counts — NEVER chat content, document text, or passwords. `conversation_exported`
     records the id only (the export filename derives from the title = chat content);
     `settings_changed` fires only for privacy-relevant keys (`allowNetwork`, `gpuMode`,
     `developerMode`) and records those keys' post-validation values, never other settings'
     values. `tests/integration/audit-ipc.test.ts` seeds sentinels through the wired
     chat/docs/settings/password flows and greps every recorded row for absence.
  3. **Wiring is shallow (IPC layer + main/index.ts, services stay pure):** registerCoreIpc
     (settings_changed), registerModelIpc (model_selected/verified,
     runtime_started/stopped — auto-start included via `startModelRuntime`), registerChatIpc
     (conversation_deleted/exported), registerDocsIpc (document_imported/reindexed/deleted),
     registerWorkspaceIpc (workspace_created/unlocked/locked/unlock_failed),
     registerDownloadIpc → **injected `DownloadManagerDeps.audit` hook** (the manager's
     background verify/fail outcomes reach the log without the service touching the DB;
     placeholder-hash completion records NO "verified" — checksum honesty). `main/index.ts`:
     runtime_fallback (`persistGpuFailure`), runtime_crashed (the §5.3 crash wrapper),
     policy_warning (startup `loadPolicy` warnings, recorded post-ctx via the buffer),
     offline_guard_violation (new optional `assertOfflinePosture.onViolation` hook).
  4. **Surface:** Diagnostics **Activity** panel — on-demand load, client-side type filter,
     "Show earlier activity" (`beforeId` paging), **Export to file…** (JSON via the
     exportConversation save-dialog pattern). New IPC `getAuditEvents(limit, beforeId?)`
     (`audit:list`) + `exportAuditLog()` (`audit:export`) in `ipc/registerAuditIpc.ts`;
     preload exposes both. §11.4 copy ("A local record of what the app did…").
  Tests: `tests/integration/audit.test.ts` (8: never-throws, paging/tie-break, D7 retention
  at the real 5 000 ceiling, recorder buffering) + `audit-ipc.test.ts` (5: the sentinel
  grep across all wired flows incl. a real fake-fetch download, locked→flush workspace
  round-trip on a real encrypted vault, IPC paging, export/cancel) +
  `tests/renderer/DiagnosticsActivity.test.tsx` (4). Gate: typecheck clean, 542 tests,
  build green.
- **Phase 20 — answer-depth modes Fast/Balanced/Deep (2026-06-10, plan
  [`docs/post-mvp-functionality-plan.md`](docs/post-mvp-functionality-plan.md) §8, "as
  implemented" in §8.1; mechanism doc in `docs/architecture.md`):** the dead
  `ChatOptions.mode` plumbing and the manifest `supports_thinking_mode` flag are now live —
  the spec §10.3 selector exists. The whole mechanism is request-side per-call state; nothing
  about it persists to the DB (no schema change) and the MockRuntime ignores it.
  1. **D5 RESOLVED (a) — per-request `chat_template_kwargs: { enable_thinking: <bool> }`,
     verified against the PINNED llama.cpp b9585 SOURCE** (not docs): the server merges the
     request kwarg over its CLI default and accepts JSON booleans
     (`tools/server/server-common.cpp` L1074–1088); the kwarg only acts in the **jinja**
     template path, and `use_jinja = true` is the b9585 server default (`common/common.h`
     L609); default `--reasoning-format` is deepseek-style, which extracts thinking into
     SEPARATE `delta.reasoning_content` streaming frames (`common/common.h` L612,
     `tools/server/server-chat.cpp` L550–557). The Qwen3 `/think`·`/no_think` soft-switch
     fallback is NOT needed and NOT used (it would leak into transcripts).
     **Found while verifying: at b9585 `--reasoning auto` (default) turns thinking ON for
     any capable template** (`server-context.cpp` L1237–1239) — all four bundled Qwen3
     models were already thinking on every reply and our SSE parser silently DROPPED those
     deltas (pure latency, no output; the gpu-smoke's `/no_think` workaround was the tell).
     So `enable_thinking` is now ALWAYS sent explicitly — `false` unless deep.
  2. **`CHAT_SERVER_ARGS` (LOCKED): every CHAT sidecar spawns with `--jinja
     --reasoning-format deepseek`** (`llama.ts`, prepended before ladder extraArgs) — pins
     the two preconditions of D5 in code instead of assuming upstream defaults. The E5
     embedder composes `LlamaServer` directly and does NOT get these. Consequence: a
     `PAID_LLAMA_BIN` override must point at a build new enough for both flags (the pinned
     b9585 qualifies; so do all builds the drives ship).
  3. **D4 RESOLVED — mode → request mapping (one place: `requestParamsForMode` in
     `llama.ts`):** `fast` → thinking off + `temperature 0.7` + `max_tokens 1024`;
     `balanced` AND omitted mode → thinking off, no sampling overrides (server/model
     defaults — today's intended behavior, now explicit); `deep` → thinking ON +
     `temperature 0.6` (Qwen3's documented thinking-mode sampling), uncapped. Explicit
     `RuntimeChatOptions.maxTokens`/`temperature` always win over mode-derived values.
     (The plan wanted release-matrix tok/s to inform this; the matrix hasn't run — values
     come from Qwen3's model-card guidance and can be tuned when it lands.)
  4. **Streaming contract untouched; ONE additive channel:** Deep-mode reasoning deltas go
     out on **`chat:reasoning:<id>`** (preload `onReasoning`); `chat:token:<id>` still
     carries answer tokens only. Inside the runtime, `RuntimeChatOptions` gained
     `mode` + `onReasoning(delta)` — the chatStream generator still yields answer strings
     only, so every existing consumer (RAG, benchmark tok/s) is unchanged.
  5. **D6 enforced (strip everywhere):** new `stripThinkBlocks` (services/chat.ts) removes
     `<think>…</think>` (and an unclosed trailing block from a mid-thought Stop) — applied
     to assistant content BEFORE persisting (chat AND grounded paths; an all-think aborted
     reply persists nothing, like the L2 zero-token stop) and to assistant turns replayed
     as history (`buildChatMessages` + `buildGroundedChatMessages`; Qwen guidance: never
     feed think blocks back). Normal Phase-20 output never contains inline tags (deepseek
     format separates them) — the strip is defense-in-depth + legacy-row hygiene. The
     collapsed live "Thinking…" `<details>` block on the streaming bubble is the ONLY place
     reasoning is visible; it vanishes when the persisted reply replaces the live bubble.
  6. **Deep is capability-gated by the manifest:** `supports_thinking_mode` is now parsed
     into `ModelManifest.supportsThinkingMode` (optional boolean, default false, type-checked)
     and the `getRuntimeStatus` handler enriches `RuntimeStatus.supportsThinkingMode` for the
     RUNNING model (manifest reads only while running — the ChatScreen's not-running poll
     stays I/O-free). The composer offers Deep only when true; a sticky Deep choice on a
     model without support coerces to Balanced at send time. The four bundled Qwen3 chat
     manifests are original hybrid-thinking releases — `true` is correct for all of them
     (`model-policy.md` records the 2507-Instruct caveat).
  7. **Renderer:** composer "Answer depth" pill row (chat mode only — `askDocuments` always
     runs balanced this wave, plan §8), sticky per conversation for the session
     (per-message over IPC, enum-guarded in the handler like `gpuMode`). The depth choice is
     NOT persisted to the DB (accepted edge in `known-limitations.md`).
  8. **Phase-19 interplay:** NO new audit events (a mode choice is chat-adjacent state;
     recording it would add noise, and reasoning content could never be recorded anyway —
     privacy rule). The sentinel-grep test surface is unchanged.
  Tests (+30, all through existing harnesses — fake spawn/fetch, temp DBs, fake ipcMain):
  `llama-runtime.test.ts` (D4 table, kwargs/sampling per mode, explicit-overrides-win,
  reasoning→callback never→yield, CHAT_SERVER_ARGS + ladder-args composition),
  `chat.test.ts` (stripThinkBlocks cases; persist-strip; only-thinking persists nothing;
  history scrub assistant-only; mode/onReasoning forwarding), `rag.test.ts` (grounded
  answers send NO mode; grounded persist-strip; grounded history scrub), `chat-ipc.test.ts`
  (reasoning channel separation end-to-end, junk-mode enum guard), `manifest.test.ts`
  (supports_thinking_mode parse/default/type-error), `core-model-ipc.test.ts`
  (RuntimeStatus enrichment running/stopped), `tests/renderer/ChatDepth.test.tsx` (6: Deep
  gating, selector hidden in documents mode, depth sent + balanced default, per-conversation
  stickiness, collapsed-block live rendering + disappearance after persist). NEW manual
  harness `tests/manual/thinking-smoke.test.ts` (`PAID_THINKING_SMOKE=<drive root>`,
  gpu-smoke pattern): real b9585 + real Qwen3 — deep streams separate reasoning + clean
  answer, balanced streams zero reasoning deltas. CI stays zero-network/zero-model.
  Gate: typecheck clean, 572 tests, build green.

---

## 4. Shared data contracts (the actual "transported data")

> Source of truth for cross-module/cross-phase types. Keep in sync with `apps/desktop/src/shared/`.
> Phases append/refine here so later phases know the exact shapes.

### IPC command surface (spec §9.1) — target
```ts
getAppStatus(): Promise<AppStatus>
getDriveStatus(): Promise<DriveStatus>
runBenchmark(): Promise<BenchmarkResult>
listModels(): Promise<ModelInfo[]>
selectModel(modelId: string): Promise<void>
startRuntime(modelId: string): Promise<RuntimeStatus>
stopRuntime(): Promise<void>
createConversation(): Promise<Conversation>
sendChatMessage(conversationId, message, options): stream → events
askDocuments(conversationId, question): stream → events
importDocuments(paths: string[]): Promise<ImportJob>
getImportJob(jobId: string): Promise<ImportJobStatus>
listDocuments(): Promise<DocumentInfo[]>
deleteDocument(documentId: string): Promise<void>
getSettings(): Promise<AppSettings>
updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
```
_Status: TypeScript types in `apps/desktop/src/shared/types.ts`; channel names in `src/shared/ipc.ts`.
Wired so far: core (Phase 1) + `listModels`/`selectModel`/`startRuntime`/`stopRuntime` (Phase 2) +
`createConversation`/`listConversations`/`listMessages`/`sendChatMessage`/`stopGeneration` (Phase 3) +
`pickDocuments`/`importDocuments`/`getImportJob`/`listDocuments`/`deleteDocument`/`reindexDocument`
(Phase 4) + `askDocuments` (Phase 6) + `runBenchmark` (Phase 7) + `getPolicy` (Phase 8) +
`getWorkspaceState`/`unlockWorkspace`/`createWorkspace`/`lockWorkspace` (Phase 9) +
`runPreflight` (Phase 13) + `getRuntimeStatus`/`exportConversation`/`getLogTail` (audit round 4 —
spec §7.6 export + §7.11 Diagnostics) + `getRuntimeInstall` (`runtime:install`, Phase 16) +
`tryGpuAgain` (`gpu:try-again`, GPU audit round) + the `runtime:notice` main→renderer event
channel (Phase 15, `EVENTS.runtimeNotice`, preload `onRuntimeNotice`) +
`deleteConversation` (`chat:deleteConversation`), `verifyModel` (`models:verify`) and
`previewDocument` (`docs:preview`) from the post-MVP UX polish rounds +
`updateConversationScope` (`chat:updateScope`, Phase 17 — replace/clear a documents
conversation's "ask selected documents" scope) +
`downloadModel`/`getDownloadJob`/`cancelDownload` (`downloads:start/get/cancel`, Phase 18 —
the in-app model downloader, async-with-polling) +
`getAuditEvents(limit?, beforeId?)`/`exportAuditLog` (`audit:list`/`audit:export`, Phase 19 —
the Diagnostics Activity panel, newest-first paging + save-dialog export).
(`pickDocuments` + `reindexDocument` are Phase-4 additions to the `IPC` registry beyond the spec
§9.1 list — picker + re-index UX; `getPolicy` is a Phase-8 addition; the four `workspace:*` channels
are Phase-9 additions.) `createConversation` now also accepts an optional `mode`
('chat' | 'documents') and an optional `scopeDocumentIds` (Phase 17); `Conversation` carries
`scopeDocumentIds: string[] | null` (additive `conversations.scope_json` column, guarded
ALTER-TABLE migration in `db.ts`)._

### DB schema
✅ Implemented in `src/main/services/db.ts` — all spec §8 tables created idempotently (WAL mode,
foreign keys on). `Db` type = `InstanceType<typeof DatabaseSync>`. Loaded via `createRequire`
(see Decision log). Helpers: `openDatabase(path)`, `listTables(db)`.

### Settings storage
✅ `src/main/services/settings.ts` — key/value rows; `getSettings` merges over `DEFAULT_SETTINGS`;
`updateSettings(patch)` upserts; `seedSettings` seeds on first run. Default `allowNetwork:false`,
`workspaceMode:'plaintext_dev'`, `contextTokens:4096`. **Phase 7 added `lastBenchmark`**
(JSON `BenchmarkResult | null`, default `null`) — the persisted hardware profile lives here.
**The post-MVP UX round added `autoStartActiveModel`** (boolean, default `true`) **and
`checksumCache`** (`Record<path, {size, mtimeMs, sha256}>`, default `{}` — the persisted L2 of
the weight-file hash cache).
⚠️ **Settings live INSIDE the (possibly encrypted) DB** — unreadable before unlock (Phase 9). The
unencrypted `config/workspace.json` vault descriptor is the only pre-unlock artifact;
`workspaceMode` is set to the active mode by the `WorkspaceController` on open.

### Workspace/paths
✅ `src/main/services/workspace.ts` — `resolvePaths({envRoot,fallbackRoot})` → `ResolvedPaths`
(rootPath, workspacePath, modelsPath, logsPath, configPath, dbPath, isPreparedDrive).
`ensureWorkspaceDirs`, `buildDriveStatus` (adds platform/arch/free/writable). See `docs/drive-layout.md`.

### Core IPC (Phase 1 live)
✅ `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings` registered in
`src/main/ipc/registerCoreIpc.ts`, invoked from `initBackend()` in `main/index.ts`.

### Models + runtime (Phase 2 live)
✅ **Manifest** schema/validator in `src/shared/manifest.ts` (`ModelManifest`, `validateManifest`,
`isRealSha256`). YAML files under `model-manifests/` (chat: Qwen3 4B/8B/14B Q4 + 30B-A3B MoE;
embeddings: E5 small F16 — five manifests total; 1.7B dropped, see §9).
✅ **`services/models.ts`** — `resolveManifestsDir`, `discoverManifests`, `sha256File`,
`verifyChecksum`, `computeInstallState`, `recommendModelId`, `buildModelList`, `selectModel`.
States: `unsupported→missing→checksum_failed→installed` (+`running` overlay). `ModelInfo` shape per
`shared/types.ts`. `local_path` resolved against the **drive root**.
✅ **`services/runtime/`** — `ModelRuntime` interface + `RuntimeManager` (single active runtime,
restart on switch) + `MockRuntime` (health ok; `chatStream` stubbed until Phase 3). Factory swap →
`LlamaRuntime` in Phase 10. `RuntimeStatus` shape per `shared/types.ts`.
✅ **IPC** `src/main/ipc/registerModelIpc.ts` — `listModels`, `selectModel`, `startRuntime`,
`stopRuntime`; wired in `initBackend()`. `ctx` now carries `runtime` + `manifestsDir`. Runtime stopped
on `will-quit`. Preload exposes all four. **Models screen** renders states/license/recommend/verify/
select/start-stop. Hardware profile now comes from the **persisted Phase-7 benchmark**
(`lastBenchmark?.profile ?? 'UNKNOWN'`); the old `LITE` stub is gone.

### Chat + streaming (Phase 3 live)
✅ **`services/chat.ts`** (spec §7.6) — `createConversation`, `listConversations`,
`getConversation`, `listMessages`, `appendMessage`, `deleteLastAssistantMessage`,
`maybeSetTitleFromFirstMessage`, `buildSystemPrompt` (verbatim spec §7.6 base prompt, exported as
`BASE_SYSTEM_PROMPT`), `buildChatMessages`, and the streaming orchestrator
`generateAssistantMessage(db, runtime, conversationId, { signal, onToken })`. UUID v4 ids,
ISO-8601 UTC timestamps. **Message order = `created_at ASC, rowid ASC`** (rowid breaks
equal-ms ties → stable turn order). **System prompt is built per request, NOT persisted**; the
`messages` table holds only user/assistant turns. `Conversation`/`Message` shapes per
`shared/types.ts`. `messages.citations_json` stays null until Phase 6.
✅ **Title:** new conversations are `"New chat"`; first user message sets the title (≤60 chars),
later messages don't overwrite it. Conversations list newest-updated first.

### Streaming contract (LOCKED — Phase 3; one ADDITIVE channel in Phase 20)
Main → renderer over per-conversation IPC event channels keyed by the **conversation id**
(one active stream per conversation): `chat:token:<id>` (one token/event) / `chat:done:<id>`
(final assistant `Message`) / `chat:error:<id>` (error string). Helpers in `src/shared/ipc.ts`
`STREAM`. Preload exposes `onToken/onDone/onError(requestId, cb) → unsubscribe`. In addition,
`sendChatMessage(conversationId, content, options?)` resolves with the final assistant `Message`,
so callers can simply `await` it; the event channels drive incremental UI.
**Phase 20 (additive):** `chat:reasoning:<id>` (preload `onReasoning`) carries Deep-mode
thinking deltas; token events still carry ONLY answer text. Reasoning is never persisted and
never replayed (D6) — see "Answer-depth modes" below.
**Cancellation:** `ipc/registerChatIpc.ts` keeps a per-conversation `AbortController` map;
`stopGeneration(conversationId)` aborts it → `chatStream` stops on `options.signal`, the partial
reply is persisted, a normal `done` fires.
**Regenerate:** `sendChatMessage` with `options.regenerate = true` deletes the last assistant
message and re-streams from existing history (no new user turn).
**Decision (documented):** `sendChatMessage` does **not** auto-start a runtime — a chat needs a
model explicitly started on the Models screen. No active runtime → handler throws; Chat screen
shows a "start a model" empty state linking to Models. (Heavy llama.cpp start in Phase 10 stays an
explicit user action; keeps the boundary clean.)
✅ **`MockRuntime.chatStream`** now emits a deterministic reply token-by-token (12 ms/token) that
echoes the last user message, honouring `options.signal` for prompt cancellation. **Chat screen**
(`renderer/screens/ChatScreen.tsx`): conversation list, streamed transcript with a live cursor,
stop, regenerate, per-message copy, and the no-runtime empty state.

### Answer-depth modes (Phase 20 live)
✅ `ChatOptions.mode` (`'fast' | 'balanced' | 'deep'` = `ChatDepthMode`) is **read** now:
per message over IPC (enum-guarded in `registerChatIpc`), sticky per conversation in the
renderer for the session (NOT persisted — no schema change). Threads
`generateAssistantMessage` → `RuntimeChatOptions.mode`; the single mapping site is
`runtime/llama.ts` `requestParamsForMode` (D4): fast = thinking off + temp 0.7 + 1024-token
cap · balanced/omitted = thinking off, server defaults · deep = thinking on + temp 0.6.
Explicit `maxTokens`/`temperature` win over mode-derived values.
✅ **Thinking switch (D5):** per-request `chat_template_kwargs: { enable_thinking }` on
`/v1/chat/completions`, ALWAYS sent explicitly (the b9585 default is thinking ON for capable
templates). Chat sidecars spawn with **`CHAT_SERVER_ARGS` = `--jinja --reasoning-format
deepseek`** (pins the mechanism's preconditions; embedder excluded). Reasoning streams as
separate `delta.reasoning_content` frames → `RuntimeChatOptions.onReasoning(delta)` →
`chat:reasoning:<id>`; the generator yields answer text only.
✅ **D6:** `stripThinkBlocks` (services/chat.ts) scrubs `<think>…</think>` (incl. an unclosed
trailing block) from persisted assistant content (chat + grounded) and from assistant turns
replayed as history. The collapsed live "Thinking…" block in the streaming bubble is the only
reasoning surface, and it disappears once the persisted reply lands.
✅ **Deep gating:** manifest `supports_thinking_mode` → `ModelManifest.supportsThinkingMode`
(optional boolean, default false) → `RuntimeStatus.supportsThinkingMode` (enriched by the
`getRuntimeStatus` handler for the running model only) → the composer offers Deep only when
true (stale Deep choices coerce to Balanced at send). `askDocuments` never passes a mode —
document answers always run balanced (deep-grounded = wave 2).

### Document ingestion (Phase 4 live)
✅ **`services/ingestion/`** (spec §7.7). Full detail in [`docs/rag-design.md`](docs/rag-design.md).
- **`parsers/`** — `DocumentParser` interface (`{ segments: ExtractedSegment[], mimeType }`) +
  registry (`selectParser`, `supportedExtensions`). Adapters: `TxtParser` (.txt/.text/.log),
  `MarkdownParser` (.md/.markdown/.mdown; segment per ATX heading, `sectionLabel`), `PdfParser`
  (.pdf; pdfjs-dist **legacy** build, no worker; segment per page, `pageNumber`), `DocxParser`
  (.docx; mammoth raw text; segment per paragraph), `CsvParser` (.csv/.tsv; papaparse; rows →
  `header: value` lines). Pure-JS, **lazy-imported** inside `parse()`.
- **`chunker.ts`** — `chunkSegments(segments, opts?)` → `DocumentChunk[]`. `CHUNK_DEFAULTS =
  { chunkSizeTokens: 500, chunkOverlapTokens: 80, maxChunks: 1000 }`. **Token counting is an
  approximation** (1 whitespace word ≈ 1 token; `tokenize`/`approxTokenCount`). Windows step by
  `size − overlap`, overlap clamped `< size`, no chunk crosses a segment boundary (so each chunk
  has exactly one `pageNumber`/`sectionLabel`), global cap at `maxChunks`.
- **`index.ts`** — lifecycle + persistence. `createQueuedDocument`, `processDocument` (never
  throws: failures → `failed` + `error_message`), `reindexDocument`, `listDocuments`,
  `getDocument`, `deleteDocument`, `expandPaths`, `documentsDir`. Statuses
  `queued→extracting→chunking→embedding→indexed` (+`failed`/`deleted`); **`embedding` is a
  pass-through** until Phase 5 (no vectors written yet).
- **DB:** `documents` (status, `original_path`, `stored_path`, `sha256`, `mime_type`,
  `size_bytes`) + `chunks` (`chunk_index`, `text`, `source_label` = document title,
  `page_number`, `section_label`, `token_count`). `chunkCount` is computed per `listDocuments`.
- **Types:** `DocumentInfo`, `ImportJob`, `ImportJobStatus`, `IngestionStatus` (already in
  `shared/types.ts`) filled to match.

### Document storage + import model (LOCKED — Phase 4)
- **Stored copy.** Imports are **copied into `workspace/documents/<id><ext>`** (`stored_path`);
  `original_path` is also kept. Self-contained drive: re-index re-parses the stored copy; delete
  removes the stored copy + chunks + embeddings + row (never the original).
- **Async-with-polling.** `importDocuments(paths)` expands the selection, inserts `queued` rows,
  returns `{ jobId, documentIds }`, then ingests **sequentially in the background**. The
  `documents` table is the per-file source of truth (survives restart); the `ImportJobStatus`
  aggregate is **in-memory** in `registerDocsIpc.ts`, read via `getImportJob(jobId)` (unknown job
  → `done:true` so pollers stop). The **Documents screen** polls `getImportJob` + `listDocuments`
  every 400 ms while a job runs. No streaming channel is used (ingestion progress is coarse).
- **Picker.** `pickDocuments('files' | 'folder')` opens the OS dialog in **main**
  (renderer has no dialog access); Windows can't mix file+dir selection, hence the mode.
- **Documents screen** (`renderer/screens/DocumentsScreen.tsx`): import files/folder, per-file
  status badge + chunk count + size, error surfacing, delete + re-index.

### Embeddings + vector search (Phase 5 live)
✅ **`services/embeddings/`** (spec §6, §7.8, §9.2). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §6.
- **`index.ts`** — `Embedder` interface (`id`, `dimensions`, `embed(texts) =>
  Promise<Float32Array[]>` — L2-normalized, one per input); `encodeVector`/`decodeVector`
  (Float32 ↔ BLOB; decode copies to a 4-byte-aligned buffer); `cosineSimilarity`; and the
  `VectorIndex` class (`search(queryVector, topK)` linear-scan cosine → `{ chunkId, score }[]`
  sorted desc, dimension-mismatched rows skipped; `searchText(query, topK)` embeds then searches).
- **`mock.ts`** — `MockEmbedder` (`createMockEmbedder`): deterministic feature-hashing vectors
  (SHA-256 tokens → signed buckets → L2-normalize), zero network. `MOCK_EMBEDDING_DIMENSIONS =
  384`, `MOCK_EMBEDDING_MODEL_ID = 'mock-embedder'`.
- **Ingestion wiring:** `processDocument`/`reindexDocument` accept `IngestionDeps
  { embedder?, embeddingModelId? }`; the `embedding` step embeds all chunks in one batch and
  inserts `embeddings` rows. `registerDocsIpc` passes `ctx.embedder` +
  `getSettings(db).activeEmbeddingModelId`. **`AppContext` now carries `embedder`** (created in
  `main/index.ts`).
- **`embeddings` table** (spec §8, already existed): `chunk_id` PK, `embedding_model_id`,
  `vector_blob` (raw Float32 bytes), `dimensions`, `created_at`. No new IPC (askDocuments = Phase 6).

### RAG chat with citations (Phase 6 live)
✅ **`services/rag/index.ts`** (spec §7.6, §7.8). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §8.
- **`retrieve(db, embedder, question, settings)`** → `{ chunks: RetrievedChunk[], citations:
  Citation[] }`. Embeds the question, `VectorIndex.searchText(topKInitial)`, joins hits →
  `chunks`, drops `< minSimilarity`, **dedups by `(document_id, page_number)`** (page-less
  chunks keyed by chunk id), trims to `topKFinal` under `maxContextTokens` (chunker's
  `approxTokenCount`; top chunk always kept), assigns `[S1]…` labels **per query (not
  stored)**.
- **`buildGroundedPrompt(question, chunks)`** — pure; spec §7.8 template verbatim (rules +
  `Question:` + numbered `Document excerpts:` as `[Sn] File: X | Page: 4` / `| Section: Y` +
  quoted text + trailing `Answer:`). `buildGroundedChatMessages` replaces the **last user
  turn** with the grounded prompt; system stays `BASE_SYSTEM_PROMPT`.
- **`generateGroundedAnswer(...)`** — streams via the runtime and persists the assistant turn
  **with `Citation[]`** (→ `citations_json`). **Empty corpus / weak retrieval → runtime NOT
  called**; persists `NO_DOCUMENT_CONTEXT_ANSWER`, no citations.
- **`ipc/registerRagIpc.ts`** — `askDocuments(conversationId, question)`; **reuses the locked
  Phase-3 streaming contract** (`chat:token/done/error:<id>`) + the **shared in-flight
  registry** (`ipc/inflight.ts`) so `stopGeneration` cancels it. Requires a running runtime
  (same error as chat). Registered in `initBackend()`.
- **Settings:** `ragTopKInitial`/`ragTopKFinal`/`ragMaxContextTokens`/`ragMinSimilarity` on
  `AppSettings` + `DEFAULT_SETTINGS` (spec §7.8 defaults), read via `ragSettingsFrom`.
- **`Citation`** gained optional `snippet` (truncated chunk text, ≤ 600). **Renderer**:
  `ChatScreen` Chat/Ask-Documents toggle (mode is per-conversation), `askDocuments` path, and
  a per-message **Sources** panel with expandable cited snippets.

### Hardware benchmark + recommendation (Phase 7 live)
✅ **`services/benchmark.ts`** (spec §7.3, §11). Full detail in [`docs/benchmark.md`](docs/benchmark.md).
- **`detectSystem()`** (`node:os`) → `{ os, arch, cpuModel, cpuCores, ramGb, gpu }`; never
  throws (failed probe → `''`/`0`); `detectSystem` itself always reports `gpu: null` — the
  REAL probe lives in `runtime/gpu.ts` and is **injected** by the IPC layer (Phase 16:
  `RunBenchmarkDeps.gpu: { name, useful }`), keeping this module `child_process`-free.
- **`classifyProfile(ramGb, { tokensPerSecond?, gpuUseful? })`** — pure; spec §11.3
  thresholds + the conservative Phase-16 GPU bump (`gpuUseful` is precomputed by
  `gpuUsefulForProfile`: ≥ 6144 MiB AND not integrated) + low-tok/sec downgrade; invalid
  RAM → `UNKNOWN`.
- **`measureDriveSpeed(workspacePath)`** → `{ readMbps, writeMbps, error? }`; 8 MB temp file
  written **inside the workspace**, timed write(`fsync`)+read, **always cleaned up**, failure
  → `null` + `error`.
- **`measureTokensPerSecond(runtime)`** → number | `null` (only when a runtime is active;
  prompt + ≤64 tokens). Mock now, real in Phase 10.
- **`buildWarnings(...)`** — spec §11.4 friendly copy (weak hardware / slow drive /
  un-measurable drive); slow drive warns, never blocks.
- **`runBenchmark(deps)`** → `BenchmarkResult` (the existing `shared/types.ts` shape):
  detection + drive + optional tokens/sec + `classifyProfile` + `recommendModelId` + warnings.
- **`ipc/registerBenchmarkIpc.ts`** — `runBenchmark()` (`benchmark:run`); runs it, persists to
  `settings.lastBenchmark`, returns the result. Registered in `initBackend()`; exposed on
  preload `api.runBenchmark` + `PreloadApi`.
- **Renderer:** `DiagnosticsScreen` Run-benchmark button → RAM / CPU / OS-arch / drive
  read-write / tokens-sec / profile / recommended model + warnings; re-loads `lastBenchmark`
  on mount. `HomeScreen` profile reflects the persisted value via `getAppStatus`.

### Privacy & offline policy (Phase 8 live)
✅ **`services/policy.ts`** (spec §3.5/§3.6/§6). Pure + resilient; never throws.
- **Types** (in `shared/types.ts`): `PrivacyPolicy` (`network`/`workspace`/`models`),
  `NetworkPolicy`/`WorkspacePolicy`/`ModelsPolicy`, `PolicyStatus`. `DEFAULT_POLICY` lives in
  `policy.ts` (main-only).
- **`parsePolicy(contents, onWarn?)`** → `PrivacyPolicy` merged over `DEFAULT_POLICY`; malformed JSON
  → defaults + warn. **`mergePolicyObject(base, raw)`** maps snake_case JSON → camelCase, taking a
  field only when it is a real boolean. **`loadPolicy(configDir, onWarn?)`** → `{ policy,
  policyFilePresent, driveFilePresent, allowNetworkByDefault }` (reads optional `policy.json` +
  `drive.json`).
- **`resolveNetwork(policy, allowNetworkSetting)`** → `{ networkAllowedByPolicy, networkAllowed,
  offlineMode }` (effective = policy ∧ setting). **`buildPolicyStatus(configDir, allowNetworkSetting,
  onWarn?)`** → `PolicyStatus` (the `getPolicy()` IPC shape; `telemetryAllowed` hardcoded false).
✅ **`services/offlineGuard.ts`** — `isLoopbackHost(host)` (127.0.0.0/8, ::1, localhost exempt),
  `checkOutboundHost(host, offline)` → `{ host, violation }`, `installOfflineNetworkGuard({ offline,
  onViolation })` (wraps `net.Socket.prototype.connect`, logs remote attempts, **never blocks**,
  returns an uninstaller; no-op when not offline), `assertOfflinePosture({ posture, installGuard,
  log, warn })` (startup self-check; logs posture, installs the guard in ALL builds when offline).
✅ **IPC** `registerCoreIpc.ts`: `getPolicy` (`policy:get`) returns `buildPolicyStatus(...)`;
  `getAppStatus.offlineMode`/`networkAllowed` now come from the policy resolution. Preload exposes
  `api.getPolicy` + `PreloadApi`. `main/index.ts` calls `assertOfflinePosture()` in `initBackend()`
  and applies the dev/prod CSP response header in `createWindow()`.
✅ **Renderer:** `PrivacyScreen.tsx` (spec §7.10/§18.1 copy) replaces the placeholder — offline
  statement, "where your data lives" (`getDriveStatus`), live network state (off by default /
  disabled by policy), plaintext-dev-mode caveat, logs-local guarantee. Sidebar `offline-badge` is a
  live button (reads `getPolicy`, links to Privacy).

### Encrypted workspace (Phase 9 live)
✅ **`services/security/crypto.ts`** (spec §3.5) — pure KDF + AEAD, no I/O.
- **KDF:** `deriveKey(password, salt, params)` → 32-byte key via `scrypt`. `KdfParams =
  { algo:'scrypt', N, r, p, keyLen }`, `DEFAULT_KDF = { scrypt, 32768, 8, 1, 32 }`. `generateSalt()`
  → 16 random bytes. Deterministic for the same password+salt+params.
- **AEAD:** `encrypt(key, plaintext) → { iv(12), tag(16), ciphertext }` (AES-256-GCM, fresh IV),
  `decrypt(key, blob)` (throws on wrong key/tamper). `serializeBlob`/`deserializeBlob`
  (`MAGIC(8)|iv|tag|ct` on-disk frame). `makeVerifier(key)`/`verifyKey(key, verifier)` (password
  check via a known-plaintext GCM blob — never touches the DB).
✅ **`services/workspace-vault.ts`** (spec §7.9) — the lock/unlock lifecycle.
- **Descriptor:** `VaultDescriptor { version, mode:'encrypted', kdf, saltB64, verifier }` at
  **`config/workspace.json`** (unencrypted; the only pre-unlock artifact).
  `readVaultDescriptor`/`writeVaultDescriptor` (atomic). `vaultPathsFrom({configPath,dbPath})` →
  `VaultPaths { descriptorPath, encPath = <dbPath>.enc, dbPath }`.
- **File crypto + hygiene:** `encryptFile`/`decryptFile` (atomic temp+rename), `shredFile`
  (overwrite-random + unlink, best-effort), `cleanSidecars` (shred `-wal`/`-shm`).
- **Lifecycle:** `createEncryptedVaultOnDisk(vaultPaths, password, kdf?)` (writes descriptor + seeds
  an initial DB + encrypts → `.enc` + shreds, leaving it LOCKED); `unlockEncryptedVault(vaultPaths,
  password) → { db, key, descriptor }` (verify → decrypt → open; throws **`WrongPasswordError`**);
  `lockEncryptedVault(vaultPaths, db, key)` (checkpoint+close → re-encrypt → shred).
  `plaintextAllowed(policy, {isDev, developerMode})` gates plaintext (now **enforced**).
- **`WorkspaceController`** (stateful, on `AppContext`): `init()` (startup: plaintext opens
  immediately, encrypted stays locked, else uninitialized), `getState() → WorkspaceStateInfo`,
  `requireDb()` (throws while locked), `isUnlocked()`, `unlock(password)`, `create(password, mode)`,
  `lock()` (no-op for plaintext).
✅ **IPC** `ipc/registerWorkspaceIpc.ts` — `getWorkspaceState` (`workspace:getState`) →
  `WorkspaceStateInfo`; `unlockWorkspace(password)` / `createWorkspace(password, mode)` →
  **`WorkspaceActionResult`** (`{ok:true,state}` | `{ok:false, reason:'wrong_password'|'refused'|
  'error', message}` — a wrong password / policy refusal is a normal result, not a throw);
  `lockWorkspace` → `WorkspaceStateInfo`. Registered in `initBackend()`; exposed on preload `api` +
  `PreloadApi`.
- **Types** (`shared/types.ts`): `WorkspaceStateName` (`uninitialized|locked|unlocked`),
  `WorkspaceStateInfo { state, mode, plaintextAllowed, encryptionRequired }`, `WorkspaceActionResult`.
✅ **`AppContext.db` is now a getter** over `workspace.requireDb()` (throws while locked) +
  `AppContext.workspace: WorkspaceController`. `main/index.ts` builds the controller from
  `loadPolicy(...).policy` + `isDev`, calls `init()`, and locks on `will-quit`. `registerCoreIpc`'s
  `getAppStatus` now derives `workspaceReady = workspace.isUnlocked()` and `workspaceMode` from the
  controller (reads settings only when unlocked); `getPolicy`/status default `allowNetwork=false`
  while locked (offline ceiling stays intact pre-unlock).
✅ **Renderer:** `screens/WorkspaceGate.tsx` — the pre-app create-password / unlock gate (encrypted
  vs plaintext choice when policy allows, confirm + strength hint, wrong-password error). `App.tsx`
  fetches `getWorkspaceState()` on mount and renders the gate until `unlocked`; sidebar **Lock now**
  button (encrypted only) calls `lockWorkspace`. The Settings workspace card reflects the real mode.

### Real runtime + embedder (Phase 10 live)
✅ **`services/runtime/sidecar.ts`** — discovery + `LlamaServer` lifecycle.
- `resolveLlamaServerPath(rootPath, platform, env)` → binary path | null (`runtime/llama.cpp/<os>/`,
  `PAID_LLAMA_BIN` override); `llamaServerDir`/`llamaServerBinaryName`/`llamaOsDir`; `findFreePort()`;
  `defaultThreadCount()`; `LOOPBACK_HOST = '127.0.0.1'`.
- **`LlamaServer`** owns one child process: `start()` (spawn `--host 127.0.0.1 --port <random> --model
  --ctx-size --threads` + `extraArgs`, then poll `/health` with a **timeout** → throw on crash/timeout),
  `health() → HealthStatus`, `fetch(path, init)` (loopback), `stop()` (kill **and wait for exit**).
  Test seams: injectable `spawn` / `fetchImpl` / `findPort` (+ `ChildProcessLike`/`SpawnFn`/`FetchFn`).
✅ **`services/runtime/llama.ts`** — `LlamaRuntime implements ModelRuntime` (composes `LlamaServer`);
  `chatStream` → OpenAI-compatible `/v1/chat/completions` (`stream:true`, role/content, `max_tokens`/
  `temperature`), `readChatSSE(body, signal)` exported (SSE delta parser). `createLlamaRuntime(opts, deps)`.
✅ **`services/runtime/factory.ts`** — `createSelectingRuntimeFactory({ rootPath, resolveBin?,
  modelExists?, makeLlama?, makeMock?, onSelect? }) → RuntimeFactory` (real iff binary + weights present,
  per `start()`; else mock). Used by `RuntimeManager` in `main/index.ts`.
✅ **`services/embeddings/e5.ts`** — `E5Embedder implements Embedder` (id = manifest id, 384 dims,
  L2-normalized; lazy `llama-server --embedding --pooling mean` sidecar; additive `stop()`).
  `createE5Embedder(opts)`. **`Embedder` gained optional `stop?(): Promise<void>`** (mock omits it).
✅ **`services/embeddings/factory.ts`** — `createSelectedEmbedder({ rootPath, model, … }) → Embedder`
  (real `E5Embedder` iff binary + E5 weights present; else `MockEmbedder`). `EmbeddingModelInfo {
  id, modelPath, dimensions?, contextTokens? }`.
✅ **`VectorIndex`** — optional 3rd ctor arg `{ embeddingModelId? }`: a non-empty id scopes the cosine
  scan to `WHERE embedding_model_id = ?` (mismatch guard); default scans all rows. **`rag.retrieve`**
  passes `{ embeddingModelId: embedder.id }`.
✅ **`main/index.ts`** — builds the selecting runtime factory + selected embedder; `resolveEmbeddingModel`
  reads the embeddings manifest pre-unlock; `will-quit` now also calls `ctx.embedder.stop?.()`.
  **R5: live inference is manual** (binaries + GGUF not in repo); everything else is tested with a mocked
  child process / mocked loopback `fetch`.

### Drive layout, scripts & packaging (Phase 11 live)
✅ **`services/drive.ts`** — the canonical, unit-tested reference for drive prep (the scripts mirror it):
- `DRIVE_OS_DIRS = ['win','mac','linux']`, `DRIVE_LAYOUT_DIRS` (workspace, models/{chat,embeddings},
  model-manifests, runtime/llama.cpp/{win,mac,linux}, logs, config, docs), `driveLayoutDirs(root)`.
- `buildDriveJson(opts) → DriveJson` (the `config/drive.json` marker, spec §6 shape);
  `buildPolicyJson({dev?}) → PolicyJson` (snake_case; network always denied; commercial vs dev posture).
- `verifyDriveModels(root, manifests) → ModelVerifyResult[]` (status `verified|unverified_placeholder|
  mismatch|missing|unsupported`, reusing `models.ts` `verifyChecksum`/`isRealSha256`);
  `buildChecksumsJson(root, manifests) → ChecksumsJson` (generate-mode capture of present-weight hashes).
- `planPrepareDrive(root, manifests, opts) → PreparePlan` (dirs + config files + manifest copies +
  weight destinations + `configWouldOverwrite`) + `formatPlan` (the dry-run report).
✅ **`scripts/`** (repo root, self-contained; no Node/npm needed to prep a drive):
- `prepare-drive.{ps1,sh}` — `-Target`/`--target` (required), `-DryRun`/`--dry-run`, `-Force`/`--force`,
  `-Dev`/`--dev`. Creates the layout, copies `model-manifests/` + user docs onto the drive, writes
  `config/{drive,policy}.json`. Idempotent; config only (re)written with `--force`.
- `verify-models.{ps1,sh}` — `-Target`/`--target`, `-Generate`/`--generate`. Flat-YAML line-parses the
  manifests, SHA-256s present weights, prints `VERIFIED/UNVERIFIED/MISMATCH/MISSING/UNSUPPORTED`,
  **exit 1 on a real-hash mismatch**; `--generate` writes `config/checksums.json`.
- `setup-dev.{ps1,sh}` — `NODE_OPTIONS=--use-system-ca npm install` (R6) + build + test smoke.
✅ **Packaging** — `apps/desktop/electron-builder.yml` (portable Windows + mac/linux parity;
  `model-manifests/` as `extraResources`; asar; Electron ≥37). `npm run package` / `package:win`
  (root + workspace). New dev dep **`electron-builder ^26.15.2`**. Output → `apps/desktop/release/`
  (git-ignored, added to `.gitignore` alongside the existing `models/`/`*.gguf`/`/runtime/` ignores).
✅ **Docs** — `docs/user-guide.md` (non-technical §17 path) + `docs/troubleshooting.md` (§18) added;
  `docs/packaging.md` + `docs/drive-layout.md` extended (portable build, the scripts, win/mac/linux
  reconciliation). prepare-drive copies user-guide/troubleshooting + `PRIVACY.md` onto the drive.

### Provisioning / asset loader (Phase 12 live)
✅ **Schema** — `shared/manifest.ts` `DownloadSpec` + optional `ModelManifest.download` (validated only
  when present; real `download.sha256` must equal a real top-level `sha256`). `shared/runtime-sources.ts`
  `RuntimeBuild`/`RuntimeSources` + `validateRuntimeSources` (mirror `validateManifest`). The committed
  model manifests (six, incl. the later 14B/30B-A3B) carry real upstream URLs + placeholder hashes;
  `model-manifests/runtime-sources.yaml` references `ggml-org/llama.cpp@b9196` — a **PLACEHOLDER**
  version/URLs/hashes to be replaced with a real release before any fetch — one CPU build per OS.
  `models.ts` `RESERVED_MANIFEST_FILES` excludes `runtime-sources.yaml` from model discovery.
✅ **`services/assets.ts`** — the canonical, unit-tested asset logic (mirrors `drive.ts`; NO real network):
- `planModelDownloads(root, manifests, {only?, acceptLicense?}) → ModelDownloadTask[]` — only manifests
  with a `download` block; reads fs to mark `present-verified`/`present-unverified`/`download`/
  `license-blocked` (license gate ∧ `acceptLicense`); reuses `weightPath`/`verifyChecksum`.
- `selectRuntimeBuild(sources, {os, arch, backend?}) → RuntimeBuild | null` (default = first os/arch
  match = the CPU build) · `planRuntimeDownload(root, build, version) → {url, zipDest, extractTo,
  binaryPath, sha256, ...}` (escape-guarded) · `runtimeBinaryName(os)`.
- `verifyDownloadedFile(path, expected) → {ok, actual, reason}` (placeholder/missing/mismatch are NOT a
  pass) · `downloadToFile(url, dest, {fetchImpl?, onProgress?})` + `fetchAndVerify(task, deps)` (injected
  fetch; mismatch deletes the partial + throws) · `formatAssetPlan(modelTasks, runtimePlan)`.
✅ **`scripts/`** (self-contained, dual `.ps1`/`.sh`, OS-native downloader; `.ps1` pure ASCII):
- `fetch-models.{ps1,sh}` — `-Target`/`--target` (req), `-Only`/`--only`, `-AcceptLicense`/
  `--accept-license`, `-DryRun`/`--dry-run`. Per `download`-block manifest: download (resume via
  `curl -C -`/`aria2c`) → SHA-256-verify vs the manifest → mismatch deletes partial + **exit 1**;
  placeholder → *UNVERIFIED*; present+verified → skip. License gate before the first fetch.
- `fetch-runtime.{ps1,sh}` — `-Target`/`--target` (req), `-Os/-Arch/-Backend` overrides, `-DryRun`.
  Reads `runtime-sources.yaml`, picks the host build (default CPU), downloads + verifies the zip,
  `Expand-Archive`/`unzip`/`ditto` into `runtime/llama.cpp/<os>/`, `chmod +x` on mac/linux. Idempotent.
- `prepare-drive.{ps1,sh}` gained `-WithAssets`/`--with-assets` (+ forwards `-AcceptLicense`): after the
  layout, runs `fetch-models` + `fetch-runtime` so one command yields a launch-ready drive. Without the
  flag, behaviour is unchanged. Then points the user at `verify-models --generate`.
✅ **In-app downloader (plan §12.3)** — ~~deferred~~ **shipped in Phase 18** (see the contract
  section below). **Real downloads + USB-drive launch = manual (R5).**

### In-app model downloader (Phase 18 live)
✅ **Types** (`shared/types.ts`): `DownloadJobStatus = 'queued'|'downloading'|'verifying'|'done'|
  'failed'|'cancelled'`; `DownloadJob { jobId, modelId, status, receivedBytes, totalBytes,
  unverified, error }` (`unverified` = placeholder-hash download, the model stays UNVERIFIED);
  `ModelInfo.download?: ModelDownloadInfo { url, sizeBytes, licenseUrl, licenseApproved }`.
✅ **`services/downloads.ts`** — `DownloadGates { policyAllows, settingAllows }`,
  `assertDownloadAllowed(gates)` (friendly, cause-specific refusals: policy vs. Settings),
  `partPath(dest)`, `DownloadManager({ fetchImpl?, log? })` with `start({rootPath, manifest,
  gates, licenseAccepted?, hashStore?}) → Promise<DownloadJob>`, `get(jobId)`, `cancel(jobId)`
  (keeps the `.part`), `activeJob()`. One live job at a time; `.part` → verify → rename;
  mismatch deletes the partial; success invalidates the checksum-cache entry.
✅ **`assets.ts` seam (additive):** `DownloadDeps += { signal?, headers?, append?, onResponse? }`,
  `downloadToFile → DownloadToFileResult { status, received, contentLength }` (append only on a
  real 206); `PlanModelOptions += { hashStore? }` (present multi-GB weights are not re-hashed).
✅ **IPC** `ipc/registerDownloadIpc.ts` — `downloadModel(modelId, {licenseAccepted?})`,
  `getDownloadJob(jobId)`, `cancelDownload(jobId)`; gates re-read per call (policy from disk,
  setting from the possibly-locked DB ⇒ off). Preload exposes all three. **Renderer:**
  ModelsScreen Download button (missing/checksum_failed models with a manifest `download`
  block), gate explanations, the confirmation modal (size/license/URL + license-ack checkbox),
  progress + cancel via 1 s polling; SettingsScreen hint updated.

### Audit log (Phase 19 live)
✅ **Types** (`shared/types.ts`): `AuditEventType` (the 21-value union, §3 Phase-19 entry);
  `AuditEvent { id, type, message, metadata: Record<string,unknown> | null, createdAt }`.
✅ **`services/audit.ts`** — `AUDIT_MAX_ROWS = 5000`, `recordEvent(db, type, message, metadata?,
  createdAt?)` (never throws; prunes on insert), `pruneAuditEvents(db, maxRows?)`,
  `listAuditEvents(db, { limit?, beforeId? })` (newest-first; unknown cursor reads from the top),
  `createAuditRecorder(getDb) → AuditRecorder` (locked-vault memory buffer, bounded 100,
  flush-in-order with original timestamps). **`AppContext.audit?: AuditRecorder`** — optional, so
  partial test contexts stay valid; every call site is `ctx.audit?.(…)`.
✅ **`services/downloads.ts` seam (additive):** `DownloadManagerDeps.audit?` (`DownloadAuditType` =
  the three `model_download_*` values) — injected by `registerDownloadIpc` in production.
✅ **`services/offlineGuard.ts` seam (additive):** `AssertOfflinePostureDeps.onViolation?(host)`.
✅ **IPC** `ipc/registerAuditIpc.ts` — `getAuditEvents`, `exportAuditLog` (JSON, save-dialog
  pattern). **Renderer:** Diagnostics Activity card (on-demand, type filter, paging, export).
⚠️ The privacy rule (ids/filenames/counts, never content) is a CONTRACT for every future call
  site — extend the sentinel test when adding events.

### Plug-and-play distribution (Phase 13 live)
✅ **`services/launcher.ts`** — `resolveDriveRootFromLauncher(launcherPath, flavor?: 'win32'|'posix'|
  'auto')` → the drive root (the launcher's own directory; pure path math, no fs). Handles Windows
  drive-letter + POSIX/macOS paths; throws on empty/relative. **No hardcoded path** — the canonical
  reference the launcher scripts mirror.
✅ **`launchers/`** (repo templates copied to the drive root by the pipeline) — `Start Private AI
  Drive.cmd` (`%~dp0` → set `PAID_DRIVE_ROOT` → spawn `PrivateAIDriveLite-*-portable.exe`), `Start
  Private AI Drive.command` (macOS, exec the `.app` binary with the env exported), `start-private-ai-
  drive.sh` (Linux, next to the AppImage), `READ ME FIRST.txt` (friendly first-run + SmartScreen/
  Gatekeeper "Run anyway" copy).
✅ **`services/preflight.ts`** — `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) →
  PreflightResult { rootPath, writable, freeBytes, slowDriveWarning, problems[] }` (spec §11.4 tone;
  non-blocking). Reuses `buildDriveStatus` + `measureDriveSpeed`/`buildWarnings`. `LOW_FREE_SPACE_BYTES
  = 2 GB`. `PreflightResult` lives in `shared/types.ts`. IPC `runPreflight` (`preflight:run`) in
  `registerCoreIpc` → preload `api.runPreflight`; **HomeScreen** shows a non-blocking note.
✅ **`services/commercial-drive.ts`** — `planCommercialDrive({ target, os?, acceptLicense? }) →
  CommercialStep[] { id, title, command, manual, description }` (ordered: prepare → fetch-models →
  fetch-runtime → **package [manual]** → copy-app → verify → assert) + `formatPlan`; and
  `assertCommercialDrive(rootPath, manifests) → CommercialAssertion { ok, problems[], checks{
  policyCommercial, networkDenied, weightsVerified, noUserData }, modelResults }` (reuses `loadPolicy`
  + `verifyDriveModels`; flags network-allowed / plaintext / unverified-or-mismatch weights / present
  user data — `workspace/paid.sqlite[.enc]`, `config/workspace.json`, non-empty `workspace/documents/`).
✅ **`scripts/build-commercial-drive.{ps1,sh}`** — self-contained dual-shell master pipeline mirroring
  the plan; `-Target`/`--target` (req), `-AcceptLicense`/`--accept-license`, `-AppArtifact`/
  `--app-artifact` (a pre-built signed app to copy), `-SkipPackage`/`--skip-package`, `-DryRun`/
  `--dry-run`. Orchestrates prepare-drive (`-Force`) → fetch-models → fetch-runtime → (package =
  manual) → copy launchers+docs → verify-models `--generate` → native posture cross-check (exit 1 if
  not sellable). PS uses **hashtable** splatting for named params. Both dry-run-smoke-tested.
✅ **Packaging/signing** — `electron-builder.yml` `win.signtoolOptions` + `mac.notarize`/
  `hardenedRuntime`/`gatekeeperAssess:false`/`entitlements: build/entitlements.mac.plist`; secrets are
  env-driven + git-ignored. The green gate does NOT sign (it never runs electron-builder).
✅ **Tests** — `tests/integration/launcher.test.ts` (11: `resolveDriveRootFromLauncher` Win/POSIX/auto/
  empty/relative; `runPreflight` ok/slow/read-only/low-space/unmeasurable with an injected speed fn) +
  `tests/integration/commercial-drive.test.ts` (8: ordered plan + manual package + `--accept-license`
  threading + `formatPlan`; `assertCommercialDrive` passes verified-commercial, fails network/plaintext/
  placeholder-weight/user-data). **Signing + notarization + the real USB launch = manual (R5/R7).**

### MVP Definition of Done (§4 / spec §22) — checklist
| Criterion | Status |
|---|---|
| App builds on ≥1 OS | ✅ `npm run build` green (Windows) |
| Architecture supports Win/macOS/Linux | ✅ path/OS abstractions + 3 sidecar dirs + 3 builder targets |
| Local model chat works | ✅ mock now; real `LlamaRuntime` wired (live = manual, R5) |
| Local doc Q&A works | ✅ ingestion + embeddings + RAG (mock + real backends) |
| Citations work | ✅ Phase 6 (`citations_json`, source panel) |
| Manifests work | ✅ discover/validate/verify/recommend/select |
| Drive layout works | ✅ `prepare-drive` (dry-run tested); `resolvePaths` marker |
| User data local | ✅ no network in core path; loopback-only sidecars |
| Privacy docs exist | ✅ PRIVACY.md, Privacy screen, security-model |
| Setup script exists | ✅ `scripts/setup-dev.{ps1,sh}` |
| Benchmark recommendation exists | ✅ Phase 7 |
| Non-technical demo possible | ✅ documented end-to-end (user-guide.md); live run = manual (R5) |
| No cloud API | ✅ enforced (offline guard, CSP, deny-by-default policy) |
| No model weights in git | ✅ `.gitignore` (`models/`, `*.gguf`, `/runtime/`, `release/`) |
| README explains DIY | ✅ (+ user-guide + packaging + drive-layout) |
| Commercial drive layout documented | ✅ drive-layout.md + packaging.md |

**Remaining = MANUAL acceptance only (R2/R5):** producing the real portable `.exe` (Electron binary
download R2; npm-workspace dep hoisting may need a tweak) and a live USB-drive run with real weights +
sidecar binaries (not in repo). The selectors fall back to mocks when those files are absent, so dev +
CI are unaffected.

---

## 5. Next actions (do these next) — POST-MVP

**Phases 0–16 are complete. The MVP is feature-complete, the DIY asset loader ships, the
plug-and-play commercial drive is built + asserted, and GPU acceleration is in.** The remaining
items are **MANUAL acceptance only** (R2/R5/R7 + the GPU hardware matrix). In rough priority:

> **Definition of Done (MVP, spec §22 — folded in from the retired `docs/IMPLEMENTATION_PLAN.md`):**
> app builds on ≥1 OS; architecture supports Win/macOS/Linux; local model chat works; local doc
> Q&A with citations works; manifests work; drive layout works; user data local; privacy docs
> exist; setup scripts exist; benchmark recommendation exists; non-technical demo possible; no
> cloud API; no model weights in git; README explains DIY; commercial drive layout documented.
> All code-verifiable items are ✅; the demo items are the manual acceptance below.

0. **GPU acceleration (Phases 14–16) — ✅ IMPLEMENTED 2026-06-10:** see
   [`docs/gpu-support-plan.md`](docs/gpu-support-plan.md) (status flipped to IMPLEMENTED;
   deviations noted in its §13). **Phase 14 (distribution)**: vulkan-first `runtime-sources.yaml`
   (verified hashes), `<os>/cpu/` safety net, `.paid-runtime.json` install markers + marker-based
   idempotency, validator dup-check, commercial-pipeline updates. **Phase 15 (runtime)**: `gpu.ts`
   probe, the 4-rung start ladder, GPU settings keys, mid-generation crash auto-fallback, E5
   pinned to CPU — smoke-tested for real on the dev box's RTX 3080 Ti
   (`tests/manual/gpu-smoke.test.ts` with `PAID_GPU_SMOKE`: real GPU start + streamed completion).
   **Phase 16 (surface)**: Settings toggle, Diagnostics Acceleration/runtime-build lines +
   "Try GPU again", benchmark probe injection + conservative `classifyProfile` bump, friendly
   copy + docs. **Remaining for the GPU feature = release acceptance only:** the manual
   hardware matrix (item 1b below — the canonical list).
1. **Commercial-drive manual acceptance (needs certs + a real USB run, R5/R7):** obtain the code-
   signing certs (Windows OV/EV + Apple Developer ID), produce a **signed** Windows portable `.exe` +
   a **signed & notarized** macOS `.app`, run `build-commercial-drive` end-to-end onto a real drive
   (`-AppArtifact` the signed build), then do the spec §17 demo on a **fresh laptop with Wi-Fi off** +
   the **second-laptop continuity** check (same encrypted workspace, different drive letter). The
   `electron-builder.yml` hooks + the pipeline are wired; only the secrets + hardware are missing.
   **GPU additions to this checklist:** a SmartScreen sanity re-check (the
   Vulkan build adds one more unsigned DLL of the same class) and re-running `build-commercial-drive`
   end-to-end with the two-build fetch.
1b. **GPU manual hardware matrix (THIS list is canonical — release acceptance, cannot be CI'd):**
   ① Win11 + discrete NVIDIA (dev box RTX 3080 Ti — ✅ done via the Phase-15 smoke; capture tok/s
   for release notes) · ② Win + discrete AMD (Adrenalin) · ③ Win laptop, Intel Iris Xe only
   (modest gain; profile does NOT bump) · ④ Win with no GPU / Server VM / RDP session (empty probe
   → silent CPU, no scary UI) · ⑤ Win with a pre-Vulkan-1.2 GPU (clean rung-1 degradation) ·
   ⑥ Linux + NVIDIA and/or AMD (symlink-materialized libs load from exFAT) · ⑦ mac arm64
   regression (Metal unchanged) · ⑧ any GPU box: kill the driver mid-generation
   (`dxcap -forcetdr`) → §5.3 auto-fallback + friendly notice + next-message-works · ⑨ a
   `build-commercial-drive` drive moved between machines ①↔④ (flags/probe re-evaluate per machine;
   encrypted workspace continuity). The fake-spawn unit tests cover the *logic*; this matrix covers
   the *drivers*. Both are required before the release checkbox ticks.
2. **Manual acceptance (needs hardware/artifacts not in the repo, R2/R5):**
   - Provision a real drive end-to-end: `prepare-drive -WithAssets -AcceptLicense` (now downloads +
     verifies the weights + sidecar) → `verify-models -Generate` to capture the real hashes and promote
     the manifest `REPLACE_WITH_REAL_HASH` placeholders → build the portable `.exe`
     (`npm run package:win`; watch npm-workspace dep hoisting) → launch from the drive → spec §17 demo
     with Wi-Fi off. The real GGUF download + the live run are the one manual step.
3. **New functionality:** see
   [`docs/post-mvp-functionality-plan.md`](docs/post-mvp-functionality-plan.md) — **wave 1
   (Phases 17–20) toward the Office/Knowledge edition is COMPLETE**: 17 (RAG trust & scoped
   asking), 18 (in-app model downloader), 19 (audit log, incl. the Phase-18
   `model_download_*` events), 20 (Fast/Balanced/Deep answer-depth modes — D4/D5 resolved,
   see §3). Wave-2 outlines remain (reranker/hybrid retrieval, signed offline update
   bundles). Manual-acceptance items from this wave (plan §11): a real in-app download of
   the 4B on the `D:\` test drive incl. a mid-download cancel → resume; a quick
   Activity-panel eyeball on the same drive (events appear; export saves); **a real
   Deep-mode answer with visible thinking from Qwen3 4B on the test drive**
   (`tests/manual/thinking-smoke.test.ts` with `PAID_THINKING_SMOKE=<drive root>` covers the
   mechanism; the eyeball covers the UI). Smaller leftovers: an icon/`buildResources` for
   electron-builder; ANN vector index only if a real corpus outgrows the linear scan
   (plan §9 item 4).

**Current gate (2026-06-10, post-Phase-20): typecheck clean, 572/572 tests pass (+5 manual
tests — 4 GPU smoke behind `PAID_GPU_SMOKE`, 1 thinking smoke behind `PAID_THINKING_SMOKE` —
skipped in CI), `npm run build` green.** The per-phase gate history (test counts, bundle
sizes, per-phase test inventories) lives in git history.

---

## 6. Open issues / risks

- **R1 `node:sqlite` ✅ RESOLVED** — works in Electron 37 (Node 22.21) main process and in vitest
  (system Node 24). Only an experimental warning (harmless). Bundler resolution fixed via
  `createRequire` in `db.ts`. `sql.js` fallback not needed.
- **R2 Electron binary download** — `npm i electron` pulls a ~100MB binary; needs dev-time internet.
  The *app* stays offline; only dev install needs network. **Phase 11:** `electron-builder` may also
  fetch the platform Electron at package time — building the real portable `.exe` is therefore a manual,
  network-touching step (the green gate `typecheck`/`test`/`build` does NOT invoke electron-builder).
  ⚠️ **npm-workspace hoisting:** prod deps live in the **root** `node_modules`; if electron-builder
  can't collect them, build from `apps/desktop` or adjust hoisting.
- **R3 PDF/DOCX parsers ✅ RESOLVED** — `pdfjs-dist` (legacy build, `pdfjs-dist/legacy/build/pdf.mjs`)
  extracts text in the Node main process with **no Web Worker / no DOM** (validated Phase 4);
  `mammoth`/`papaparse` are pure-JS too. All three marked **external** (`externalizeDepsPlugin`) so
  pdfjs's large ESM bundle is required at runtime, not bundled. Only a harmless `standardFontDataUrl`
  warning (rendering-only). Ambient typings for the legacy path in `parsers/pdfjs.d.ts`.
- **R4 Argon2id ✅ FULLY RESOLVED (audit round 2)** — new vaults now default to **Argon2id** via the
  pure-JS `@noble/hashes` (no native `argon2`, no build risk on Node 24). `scrypt` stays supported for
  existing vaults; the descriptor's `algo` + params make unlock deterministic across both. See the KDF
  decision in §3. (Phase 9 originally shipped `scrypt` as the portable primary; the pure-JS Argon2id
  removes the only reason that was a compromise.)
- **R5 Real llama.cpp ⚠️ PARTIALLY RESOLVED (Phase 10)** — the mechanics (sidecar discovery + env
  override, localhost-only binding, OpenAI-compatible streaming, health-timeout, process cleanup, the
  real `E5Embedder`, the availability-aware fallback, the embedding-model-mismatch filter) are all
  **implemented + unit-tested** with a mocked child process / mocked loopback fetch. What remains
  **manual**: a live real-model answer, because the platform `llama-server` binaries + the GGUF weights
  are **not** in the repo (Phase 11 prepare-drive provisions them). The selectors fall back to mocks
  when those files are absent, so dev + CI are unaffected. **Phase 11** adds the scripted provisioning
  path (`prepare-drive` lays out the tree; the builder drops weights + a `llama-server` build into it;
  `verify-models --generate` captures real hashes) — but the artifacts themselves are still not in the
  repo, so the live §17 demo from a real drive remains the one manual acceptance step.
- **R6 TLS-intercepting proxy on this machine** — `npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (corporate root CA). Workaround: `NODE_OPTIONS=--use-system-ca npm install` (Node 24 reads the Windows cert store). If that fails, `npm config set strict-ssl false` (dev-only, less secure) or set `NODE_EXTRA_CA_CERTS`. Affects dev installs only; the app stays offline.
- **R7 Code-signing certificates (Phase 13) — PROCUREMENT, blocks only the *commercial* acceptance.**
  An unsigned `.exe`/`.app` launched from USB trips Windows SmartScreen / macOS Gatekeeper, which a
  non-technical buyer cannot get past. The `electron-builder.yml` hooks are wired
  (`win.signtoolOptions`, `mac.notarize` + `hardenedRuntime` + `build/entitlements.mac.plist`) and
  driven by env vars / a git-ignored secrets file — but the actual **OV/EV Windows cert** + **Apple
  Developer ID + notarization creds** cost money + lead time and are not on this machine. The green
  gate does NOT sign, the DIY path uses the unsigned "Run anyway" fallback (`docs/troubleshooting.md`),
  and the same-drive-on-a-second-laptop continuity already works (`resolvePaths`). So R7 blocks only
  the signed commercial build + the live USB §17 demo, not the repo's green gate or the DIY drive.

---

## 7. Conventions

- IDs: UUID v4 (`crypto.randomUUID()`). Timestamps: ISO-8601 UTC.
- No network in core path. No telemetry. Models/workspace/logs are git-ignored.
- Every service hides behind an interface from spec §9.2 to keep the Tauri/Rust swap open.

---

## 8. Post-MVP audits & hardening (2026-06-09 → 2026-06-10) — ALL REMEDIATED

After Phase 13, four multi-persona audit rounds (security/privacy · spec-compliance · bug-hunt ·
docs-vs-code · release/build engineering) reviewed the full repo. **Every Critical, High, and Medium
finding plus the actionable Lows were fixed** across six remediation waves. The detailed
per-finding records and the final audit report were removed in the 2026-06-10 docs cleanup — they
live in git history (`docs/audit-2026-06-09-multi-persona.md` and BUILD_STATE §8–§14 before this
commit). Highlights of what was fixed:

- **Security / data-loss:** encrypted document cache (spec §3.5 — stored copies are `.enc` in an
  encrypted workspace, with transient decrypts shredded after parsing); vault-wipe guards (`create`
  refuses over any existing vault artifact; a corrupt descriptor reports `locked`, never
  `uninitialized`); streaming file crypto + chunked shred (> 2 GiB safe); KDF param bounds-checking;
  key zeroing on lock; startup sweep of crash leftovers (`.tmp`/`.parse*`/WAL/SHM).
- **Process lifecycle:** `RuntimeManager` start/stop serialized through an op queue;
  `E5Embedder.stop()` awaits an in-flight lazy start; SIGKILL escalation gated on actual exit;
  awaited `will-quit` stops — every orphaned-`llama-server` path closed.
- **Commercial pipeline:** `fetch-runtime` sha256 parsing fixed (the key regex was structurally
  dead in both shells); `verify-models --strict` weight gate wired into `build-commercial-drive`
  step 7 (a placeholder-hash drive now exits 1); per-OS sidecar loop (one drive ships win+mac+linux);
  license-review ship gate (`checks.licensesApproved`, NOT overridable by `--accept-license`).
- **Correctness cluster:** regenerate-after-failure, conversation-switch-mid-stream,
  per-document concurrency, and lock-while-importing races; DOCX chunk packing (coalesce
  same-label segments); E5 context truncation + batching + request timeouts; checksum verification
  cached on `(path, size, mtimeMs)` (no more multi-GB re-hashing per screen mount); the spec §7.4
  model gate enforced in the MAIN process (role + install state + policy); `developerMode` defaults
  to **false**.
- **Spec completions:** automatic first-run benchmark (§2.1); chat transcript export (§7.6); full
  Diagnostics incl. local log viewer (§7.11); drive detection without the launcher
  (`config/drive.json` marker walk-up from the exe location, §7.2).
- **Manual-acceptance prep (2026-06-10):** `runtime-sources.yaml` pinned to the REAL release
  **`ggml-org/llama.cpp@b9585`** (real per-OS URLs + SHA-256 checksums, verified end-to-end from a
  Windows host for all three OSes; tar.gz + symlink-materialization + flatten handling in
  `fetch-runtime`; schannel `--ssl-revoke-best-effort` proxy fix). **License reviews COMPLETED**
  (spec §13): all six manifests are `license_review.status: approved` (Qwen3 GGUFs = apache-2.0;
  E5 = MIT via the base model, caveat recorded in the manifest notes).

Final gate: typecheck clean, **361/361 tests**, build green, no new runtime deps.

**Still open by choice:** the consciously-accepted items (no onboarding wizard, dead
Fast/Balanced/Deep plumbing, `runtime_events` unwritten, picker-only import hardening deferred,
detection-only offline guard, …) are documented in
[`docs/known-limitations.md`](docs/known-limitations.md).

---

## 9. Windows D:\ drive setup, provisioning & RAG/embedding fixes (2026-06-10)

Found during the first real Windows SSD (`D:\`) provisioning test:
`prepare-drive.ps1 -Target D:\ -WithAssets -AcceptLicense` laid out the tree + config fine
but failed at the asset-fetch step with `PositionalParameterNotFound` for `-AcceptLicense`
(misleadingly attributed to `prepare-drive.ps1`).

- **Root cause:** the `-WithAssets` block forwarded args to `fetch-models.ps1`/`fetch-runtime.ps1`
  via **array splatting** (`$a = @('-Target', $Target, '-AcceptLicense'); & $script @a`). PowerShell
  array splatting binds elements **positionally** and does NOT treat `-`-prefixed strings as parameter
  names, so `-AcceptLicense` was handed in as a positional value the child script has no slot for. A
  rooted `-Target` like `D:\` made it surface. Calling `fetch-models.ps1 -AcceptLicense` directly always
  worked — only the wrapper was broken.
- **Fix:** switched both call sites in [`scripts/prepare-drive.ps1`](scripts/prepare-drive.ps1) to
  **hashtable** splatting (`$a = @{ Target = $Target }; if ($AcceptLicense) { $a.AcceptLicense = $true }`).
  This is the **same convention already documented in §3** and already used by
  `build-commercial-drive.ps1` (§3, line ~367); `prepare-drive.ps1`'s `-WithAssets` block (added in
  Phase 12) had simply never been brought into line. The bash path is unaffected (positional args).
- **Verified:** `prepare-drive.ps1 -Target D:\ -WithAssets -AcceptLicense -DryRun` now runs cleanly
  through both `fetch-models` and `fetch-runtime`. Layout/config from the earlier non-dry run already
  succeeded on `D:\`.

**Note for the operator:** the six current manifests fetch many GB (incl. Qwen3-14B + 30B). For a
quick drive test prefer per-model fetches: `fetch-models.ps1 -Target D:\ -Only qwen3-4b-instruct-q4`
then `fetch-runtime.ps1 -Target D:\`. This is part of the still-open manual-acceptance path (§8):
fetch weights → `verify-models --generate` → live smoke test.

### Follow-on: weight-path containment false-positive at a bare drive root (`D:\`)

First `npm run dev` against the prepared `D:\` drive created the encrypted workspace + benchmarked
fine, then every `models:list` threw `Manifest local_path escapes the drive root`.

- **Root cause:** `weightPath` (and the twin `resolveWithinRoot` in `assets.ts`) guarded against
  `..`/absolute escapes with `resolved.startsWith(base + sep)`. For a **bare drive root** `resolve('D:\')`
  keeps the trailing separator, so `base + sep` doubled it (`D:\\`) and rejected every legitimate weight.
  Latent because the app-data fallback root (`C:\Users\…\AppData`) has no trailing separator — only an
  actual drive-root launch (the real portable-drive case) hits it. Tests used `/drive`, so they missed it.
- **Fix:** [`models.ts`](apps/desktop/src/main/services/models.ts) + [`assets.ts`](apps/desktop/src/main/services/assets.ts)
  now compute `prefix = base.endsWith(sep) ? base : base + sep`. Added a regression test in
  `tests/integration/models.test.ts` using `parse(process.cwd()).root` (a real trailing-sep root,
  cross-platform).
- **Gate:** typecheck clean, **362/362 tests** (+1).

### Promoting the model hash on the test drive

Drive was prepared with the **commercial posture** (`require_sha256_match: true`,
`allow_unverified_models: false`), which is authoritative and overrides dev-build leniency
(`registerModelIpc.ts developerLeniency`). So the placeholder-hash weight was rejected
(`computeInstallState → checksum_failed`). Note `verify-models --generate` only writes
`config/checksums.json` — it does NOT rewrite the manifest `sha256`. To run the real model on the
commercial drive the real hash must be promoted into the manifest's top-level `sha256`. Also note a
manifest re-copy (any `prepare-drive` re-run) overwrites a drive-only edit, so the **durable** place
to promote is the repo manifest. **Decision (operator):** promote real hashes into the **repo**
manifests. `qwen3-4b-instruct-q4` real hash
(`7485fe6f…34fdf5`) promoted in both repo + drive; shows VERIFIED. The remaining downloaded weights
(8b/14b/30b/embeddings) still need promotion (`verify-models --generate` → copy each into the repo
manifest → re-sync to drive → `verify-models -Strict`).

### Broken model sources found during the drive fetch (2026-06-10)

A full `fetch-models` against `D:\` surfaced two dead upstream sources (the others — 4b/8b/14b/30b —
return 200 and download fine):

- **`qwen3-1.7b-instruct-q4` → 404 (`EntryNotFound`).** The official `Qwen/Qwen3-1.7B-GGUF` repo ships
  **only `Qwen3-1.7B-Q8_0.gguf`** — there is no Q4_K_M. **Decision (operator): drop 1.7b from the
  set.** Deleted the manifest (repo + drive). It was the spec §7.3 recommendation for the **TINY** and
  **UNKNOWN** profiles, so `qwen3-4b-instruct-q4` (the smallest remaining chat model) now also claims
  `recommended_profiles: [TINY, LITE, UNKNOWN]`. ⚠️ **Tradeoff:** 4b wants ~8 GB RAM, so a sub-8 GB TINY
  machine should run it via Fast Mode / smaller context. `benchmark.test.ts` recommendation mapping
  updated accordingly (TINY→4b, UNKNOWN→4b).
- **`multilingual-e5-small-q8` → 401 (gated/removed).** The quant repo
  `ChristianAzinn/multilingual-e5-small-gguf` now returns 401 on both the file and the HF API. **Decision
  (operator): switch to the `cstr/multilingual-e5-small-GGUF` mirror** (identical `multilingual-e5-small-q8_0.gguf`,
  131 MB; base model intfloat/e5-small is MIT). Updated `download.url` + `size_bytes` (135 MB→131624960)
  + the §8 license-review note (provenance change recorded) in repo + drive manifests.

Gate after these changes: typecheck clean, **362/362 tests**. Still TODO on the drive: re-run
`fetch-models` (skips the 3 present big weights, fetches 8b + embeddings), then promote the remaining
hashes as above.

### RAG failure on the drive: plain-chat mode + a broken embeddings GGUF (2026-06-10)

First end-to-end RAG attempt: uploaded a PDF, asked about it, got a **fully hallucinated** answer
(invented invoice). Detailed analysis:

- **Primary cause (the hallucination): wrong chat mode.** `ChatScreen` has two tabs — **Chat**
  (`sendChatMessage` → plain LLM, NO retrieval) and **Ask Documents** (`askDocuments` →
  `generateGroundedAnswer`). The question was asked in plain Chat, so the model only saw the filename
  and confabulated. The RAG path itself is sound — it has a hard grounding guard (`rag/index.ts`
  returns a fixed "not found in your documents" answer when retrieval is empty, never calling the
  model). NOT a RAG-engine bug. (Possible UX hardening, deferred: the `staleEmbeddings` flag is gated
  on `activeEmbeddingModelId`, which stays null, so the Documents screen never warns a doc was indexed
  under a different embedder.)
- **The embedder was the mock, not E5 — same drive-root `weightPath` bug.** At startup
  `resolveEmbeddingModel` (`index.ts`) calls `weightPath('D:\', …)`; the pre-fix version threw
  "escapes the drive root", was caught, and returned null → mock embedder. Fixed by the §9 `weightPath`
  fix; on restart the E5 embedder is selected (no checksum gate on the embedder, so it loads even
  unverified). Consequence: a doc ingested under the mock is tagged `embedding_model_id='mock-embedder'`
  and is invisible to E5 retrieval (scoped by `embedder.id`) — **the document must be re-uploaded** under
  the real embedder.
- **The E5 GGUF itself was broken (TWICE).** With E5 finally selected, `llama-server --embedding`
  failed: first the q8_0 lacks `token_type_count` (BERT/XLM-R metadata) → `bert model needs to define
  token type count`; the same is true of the original quant family. Even a q8_0 that HAS the key crashes
  llama.cpp b9585 during warmup (`binary_op: unsupported types: dst f32, src1 q8_0`). **Resolution:**
  switched to an **F16** build — `keisuke-miyako/multilingual-e5-small-gguf-f16` (`multilingual-e5-small-F16.gguf`,
  242 MB). Test-loaded directly with the drive's `llama-server.exe`: loads, `server is listening`,
  returns **384-dim** embeddings. Real hash `3c3569e7…b5f6db` promoted into repo + drive manifests
  (embeddings now **VERIFIED**). The `-q8` id/local_path are kept (opaque vector tag, referenced by
  tests/docs); `display_name` → "Multilingual E5 Small (F16)". **Lesson: prefer F16 (not q8_0) for this
  BERT/XLM-R embedder on llama.cpp b9585.**

Gate: typecheck clean, **362/362 tests**. Drive: 4b + embeddings VERIFIED; 8b/14b/30b present but
UNVERIFIED (hashes still to promote). Remaining to validate RAG end-to-end: restart the app (E5 selected),
re-upload the PDF (re-embed under E5), ask in the **Ask Documents** tab.
