# BUILD STATE — Private AI Drive Lite

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)).
> It carries: current status, decisions, shared data contracts, next actions, open issues.

_Last updated: 2026-06-10 — **drive-provisioning bug fix (see §15):** `prepare-drive.ps1 -WithAssets`
forwarded args to the fetch scripts via array splatting, which broke `-AcceptLicense` binding on a real
Windows `D:\` provisioning test; switched to hashtable splatting (the §3 convention). Prior: Phase 13
complete (plug-and-play distribution: per-OS launcher + `build-commercial-drive` pipeline + signing
hooks + launch preflight) + a full post-Phase-13 code/docs audit remediation (see §10) + **audit round
4 remediation (see §11–§13)** — all findings from
[`docs/audit-2026-06-09-multi-persona.md`](docs/audit-2026-06-09-multi-persona.md) fixed, incl. the
encrypted document cache (spec §3.5) + real llama.cpp pin & license reviews (§14). MVP feature-complete;
Phases 0–13 done — this is the **last planned phase**. Earlier multi-persona audit remediation in §8/§9._

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

Legend: ⚪ not started · 🟡 in progress · 🟢 done · 🔴 blocked

> Phases 12–13 are the **post-MVP** distribution phases (the last planned work). Phase 13
> (plug-and-play distribution) is DONE — see
> [`docs/provisioning-and-distribution-plan.md`](docs/provisioning-and-distribution-plan.md).
> Remaining = **manual acceptance only**: a real signed/notarized build + a USB §17 demo (R5/R7).

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
  below TINY). **GPU rule:** a useful GPU bumps one step toward PRO (capped) — but GPU
  detection is **best-effort `null`** for now (no safe cross-platform/offline/native-free
  probe), so this branch is dormant until Phase 10.
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
  guard is installed in ALL builds when offline (audit §8 M3 superseded the original
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
spec §7.6 export + §7.11 Diagnostics).
(`pickDocuments` + `reindexDocument` are Phase-4 additions to the `IPC` registry beyond the spec
§9.1 list — picker + re-index UX; `getPolicy` is a Phase-8 addition; the four `workspace:*` channels
are Phase-9 additions.) `createConversation` now also accepts an optional `mode`
('chat' | 'documents')._

### DB schema
✅ Implemented in `src/main/services/db.ts` — all spec §8 tables created idempotently (WAL mode,
foreign keys on). `Db` type = `InstanceType<typeof DatabaseSync>`. Loaded via `createRequire`
(see Decision log). Helpers: `openDatabase(path)`, `listTables(db)`.

### Settings storage
✅ `src/main/services/settings.ts` — key/value rows; `getSettings` merges over `DEFAULT_SETTINGS`;
`updateSettings(patch)` upserts; `seedSettings` seeds on first run. Default `allowNetwork:false`,
`workspaceMode:'plaintext_dev'`, `contextTokens:4096`. **Phase 7 added `lastBenchmark`**
(JSON `BenchmarkResult | null`, default `null`) — the persisted hardware profile lives here.
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
`isRealSha256`). YAML files under `model-manifests/` (chat: Qwen3 1.7B/4B/8B/14B Q4 + 30B-A3B MoE;
embeddings: E5 small — six manifests total).
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

### Streaming contract (LOCKED — Phase 3)
Main → renderer over per-conversation IPC event channels keyed by the **conversation id**
(one active stream per conversation): `chat:token:<id>` (one token/event) / `chat:done:<id>`
(final assistant `Message`) / `chat:error:<id>` (error string). Helpers in `src/shared/ipc.ts`
`STREAM`. Preload exposes `onToken/onDone/onError(requestId, cb) → unsubscribe`. In addition,
`sendChatMessage(conversationId, content, options?)` resolves with the final assistant `Message`,
so callers can simply `await` it; the event channels drive incremental UI.
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
  throws (failed probe → `''`/`0`); **`gpu` is best-effort `null`**.
- **`classifyProfile(ramGb, { tokensPerSecond?, gpu? })`** — pure; spec §11.3 thresholds +
  GPU bump + low-tok/sec downgrade; invalid RAM → `UNKNOWN`.
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
✅ **In-app downloader (plan §12.3) = DEFERRED** (not required for DIY acceptance; deny-by-default + the
  policy/`allowNetwork` gates are documented for when it lands). **Real downloads + USB-drive launch =
  manual (R5).**

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

**Phases 0–13 are complete — this was the LAST planned phase. The MVP is feature-complete, the DIY
asset loader ships, and the plug-and-play commercial drive is built + asserted.** The remaining items
are **MANUAL acceptance only** (R2/R5/R7). In rough priority:

1. **Commercial-drive manual acceptance (needs certs + a real USB run, R5/R7):** obtain the code-
   signing certs (Windows OV/EV + Apple Developer ID), produce a **signed** Windows portable `.exe` +
   a **signed & notarized** macOS `.app`, run `build-commercial-drive` end-to-end onto a real drive
   (`-AppArtifact` the signed build), then do the spec §17 demo on a **fresh laptop with Wi-Fi off** +
   the **second-laptop continuity** check (same encrypted workspace, different drive letter). The
   `electron-builder.yml` hooks + the pipeline are wired; only the secrets + hardware are missing.
2. **Manual acceptance (needs hardware/artifacts not in the repo, R2/R5):**
   - Provision a real drive end-to-end: `prepare-drive -WithAssets -AcceptLicense` (now downloads +
     verifies the weights + sidecar) → `verify-models -Generate` to capture the real hashes and promote
     the manifest `REPLACE_WITH_REAL_HASH` placeholders → build the portable `.exe`
     (`npm run package:win`; watch npm-workspace dep hoisting) → launch from the drive → spec §17 demo
     with Wi-Fi off. The real GGUF download + the live run are the one manual step.
3. **Post-MVP polish (optional):** the in-app model downloader (plan §12.3, deferred — policy-gated +
   deny-by-default, reusing `assets.ts` `fetchAndVerify`); an icon/`buildResources` for
   electron-builder; ANN vector index (sqlite-vec/HNSW) upgrade.

Phase 13 is DONE: typecheck clean, **306/306 tests pass** (was 287 — +19: `launcher.test.ts` [11] +
`commercial-drive.test.ts` [8]), `NODE_OPTIONS=--use-system-ca npm run build` green (main bundle
**104.75 kB** — preflight IPC is now in the runtime path; the launcher/commercial-drive modules are
tested helpers). **No new runtime deps.** Both `build-commercial-drive.{ps1,sh}` dry-run-smoke-tested
on Windows PowerShell + bash (PS hashtable-splat fix verified). New manual risk **R7** (code-signing
certs). Real signed/notarized build + USB §17 demo = manual (R5/R7).

Phase 12 (prior) is DONE: typecheck clean, **287/287 tests pass** (was 247 — +40: manifest `download`-block
validation [present/absent/malformed/size/license/real-hash-equality], `validateRuntimeSources`
[8 tests], and `assets.test.ts` (28): `planModelDownloads` [no-block excluded, missing→download,
license blocked-vs-accepted-vs-approved, present-verified/unverified/mismatch, `--only`],
`selectRuntimeBuild` [default-CPU/backend-override/no-match], `planRuntimeDownload` [paths +
escape-guard + binary name], `verifyDownloadedFile` [ok/mismatch/placeholder/missing],
`downloadToFile`/`fetchAndVerify` with an **injected fetch** [streams to disk, non-OK throws, verify
pass, mismatch deletes+throws], `formatAssetPlan`). `NODE_OPTIONS=--use-system-ca npm run build` green
(main bundle **103.34 kB** — `assets.ts` is a tested helper, not yet in the runtime path). **No new
deps.** Both script families dry-run-smoke-tested on Windows PowerShell + bash. (Real downloads +
USB-drive demo = manual, R5.)

Phase 11 is DONE: typecheck clean, **198/198 tests pass** (190 prior + 8 new in `tests/integration/
drive.test.ts`: drive-layout dirs use **win/mac/linux** (not windows/macos/linux); `drive.json` is a
valid prepared-drive marker `resolvePaths` detects; `policy.json` commercial + dev variants are accepted
by `parsePolicy`/`mergePolicyObject` and **always deny network**; `planPrepareDrive` dry-run produces the
full layout + config + weight destinations + would-overwrite flag; `verifyDriveModels` reports missing/
placeholder/verified/mismatch/unsupported honestly; `buildChecksumsJson` captures real hashes for present
weights + null for absent). `NODE_OPTIONS=--use-system-ca npm run build` green (**main bundle 95.56 kB**,
unchanged — `drive.ts` is a tested helper, not in the runtime path). New dev dep **`electron-builder
^26.15.2`**. Both `.ps1` + `.sh` script families smoke-tested on Windows + bash (semantically-equivalent config
output; SHA-256 agreement across PowerShell/bash/TS). (Live `.exe` + USB-drive demo = manual, R2/R5.)

Phase 10 (prior): typecheck clean, **190/190 tests pass** (161 prior + 29 new: **sidecar** [binary
discovery present/absent/env-override, os-dir/exe-name mapping, `findFreePort`, `defaultThreadCount`;
`LlamaServer` spawns **127.0.0.1-only** never `0.0.0.0`, becomes healthy on `/health` ok with the bound
port, **health-timeout throws + kills the child** (no hang/orphan), child-exit-before-healthy throws,
`stop()` kills the child, **zero non-loopback sockets** across start/health/stop] + **llama runtime**
[`readChatSSE` yields deltas across split reads + stops on `[DONE]` + aborts on signal; `LlamaRuntime`
streams from `/v1/chat/completions`, spawn binds loopback + chat URL is `127.0.0.1`, messages sent as
role/content, options map to `max_tokens`/`stream`, non-ok HTTP throws; factory selects mock when
binary/weights absent, llama only when both present] + **e5 embedder** [embeds via loopback +
L2-normalizes, preserves input order under shuffled indices, lazy single-spawn with `--embedding` +
reuse, empty batch no-ops, count-mismatch throws; `createSelectedEmbedder` falls back to mock without
binary/weights/model, picks E5 when both present] + **embedding-mismatch** [both 384-dim blend without a
filter; id-filter scopes search so mock↔real can't blend; empty id disables the filter]).
`NODE_OPTIONS=--use-system-ca npm run build` green (**main bundle 95.56 kB**). **No new dependencies.**
(Live `npm run dev` + real-model smoke = manual, R5: needs platform binaries + a GGUF not in the repo.)

Phase 9 (prior): typecheck clean, **161/161 tests pass** (137 prior + 24 new: **crypto** [scrypt KDF
determinism with stored params, different passwords/salts diverge, unsupported algo throws;
AES-256-GCM round-trip, fresh-IV-per-encryption, wrong-key fails, ciphertext+tag tamper detection;
framed serialize/deserialize round-trip + foreign-header reject; verifier accepts right / rejects
wrong key without the DB] + **vault** [creates LOCKED on disk (descriptor+`.enc`, no working file);
lock→encrypt→unlock round-trip reads rows back, plaintext working file + `-wal`/`-shm` shredded after
lock; wrong password throws `WrongPasswordError` + writes no plaintext file; **no plaintext password
persisted** (descriptor + `.enc` scanned); plaintext-gating matrix (encryptionRequired ⇒ refused,
allowPlaintextDevMode:false ⇒ refused, non-dev ⇒ refused); `WorkspaceController`
uninitialized→unlocked→locked→unlocked + plaintext-opens-in-dev + existing-vault-starts-locked +
plaintext-create-refused; **no-network assertion** across create+unlock+lock]).
`NODE_OPTIONS=--use-system-ca npm run build` green (**main bundle 81.64 kB**). No new dependencies.
(Live `npm run dev` window smoke = manual; the unlock gate renders before the sidebar and does not
wedge HMR.)

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

## 8. Post-MVP audit remediation (2026-06-09)

A five-persona audit (security/privacy · spec-compliance · code bug-hunt · docs · build/packaging)
found no architectural defects but a cluster of real-runtime / crash-window edge cases that the
mock-first build had masked. All fixed; **typecheck clean, build green (main 100.16 kB), 205/205 tests
pass** (was 198 — 3 e5 tests re-framed + new regression tests for C1/H4/S1/M5/M7 + weightPath).

**Critical / High (correctness):**
- **C1** — Stop on a *real* runtime threw `AbortError` out of the stream → lost the partial reply +
  error toast. `generateAssistantMessage`/`generateGroundedAnswer` now treat an abort as a normal end
  (persist the partial, emit `done`) via `isAbortError` (`chat.ts`). Mock was unaffected; this only bit
  the fetch-backed `LlamaRuntime`.
- **H1** — Encrypted vault left a **plaintext `paid.sqlite` on disk after a crash** (lock-on-quit
  skipped). `WorkspaceController.init()` now shreds a stray plaintext DB + WAL/SHM on startup
  (`shredStalePlaintext`); `unlockEncryptedVault` cleans stale sidecars before decrypt (avoids replay
  corruption); `uncaughtException` locks the vault best-effort.
- **H2** — `will-quit` fire-and-forgot the sidecar kills → **orphaned `llama-server`**. Now
  `preventDefault()` → `await Promise.allSettled([runtime.stop(), embedder.stop()])` → lock →
  `app.exit(0)`, re-entry-guarded.
- **H3** — Concurrent streams on one conversation clobbered the in-flight canceller. Both IPC handlers
  reject when `inFlight.has(id)` and delete only their own entry.
- **H4** — `E5Embedder` stored 0/short-dim vectors silently (unsearchable). Now asserts each vector
  width === declared `dimensions` → the document fails visibly instead.
- **H5** — packaging: `includeSubNodeModules: true` + `npmRebuild: false` for the hoisted-workspace
  parser libs. **Still requires the manual PDF/DOCX/CSV import smoke-test on the produced `.exe`** (R2).

**Medium:** M1 PS scripts now write UTF-8 **no-BOM** (a BOM broke `JSON.parse`); "byte-identical"
claim corrected to "semantically equivalent". M2 `verify-models.sh` dropped `mapfile`/`sort -z` (macOS
Bash 3.2 safe). M3 offline guard installed in **all** builds + honest "logged, not blocked" wording.
M4 `shell.openExternal` http(s)-only allowlist. M5 startup reconcile of documents stuck mid-ingestion
by a prior run. M6 import/reindex/list/delete guard against a locked workspace. M7 `DocumentInfo.staleEmbeddings`
flags a corpus indexed under a different embedder + a Documents-screen re-index prompt.

**Low:** SSE final-line flush (`readChatSSE`); per-probe `/health` timeout + undrained child stdout
fixed (stdio refined again in §9); `weightPath` rejects `..`/absolute escapes; 8-char min vault
password; `engines.node >= 22.5`; doc fixes (stale `LITE`, dead `benchmark-plan.md` ref, `rag.ts`→`rag/`,
dev-CSP `script-src` wording).

**Deferred (intentional):** offline guard remains detection-only (blocking `net.Socket` app-wide risks
loopback IPC). _(The scrypt-N and single-tsconfig items below were resolved in §9.)_

---

## 9. Post-MVP hardening round 2 (2026-06-09)

Follow-up to §8, taking the deferred-but-valuable items plus a renderer test harness. All
in-repo, no hardware needed. **Typecheck clean (both projects), build green, 247/247 tests pass**
(was 226 — +21: argon2id, sidecar stderr, jsdom/RTL renderer tests).

- **Argon2id KDF (was deferred).** New vaults default to Argon2id via pure-JS `@noble/hashes` (OWASP
  params, ~0.5 s/unlock); scrypt still unlocks older vaults. New dep `@noble/hashes` (externalized →
  `require("@noble/hashes/argon2.js")` in the main bundle, like the parser libs; **add it to the
  post-package smoke-test** — it's loaded at unlock, R2). See §3 KDF decision + R4.
- **tsconfig node/web split (was deferred).** `tsconfig.base.json` + `tsconfig.node.json` (main/preload,
  **no DOM lib**) + `tsconfig.web.json` (renderer + tests, DOM). Root `tsconfig.json` references both;
  `typecheck` runs each with `--composite false --noEmit`. A browser global leaking into the main
  process is now a type error.
- **Sidecar failure diagnostics (S3/S5).** `LlamaServer` pipes + **drains** stderr (prevents the
  pipe-buffer deadlock) and surfaces the **exit code + stderr tail** in the start error, so a port
  conflict (`bind: address already in use`) is diagnosable instead of a blank health timeout. New
  `ReadableLike` on `ChildProcessLike` (optional; fake children omit it).
- **Renderer test harness (jsdom + RTL).** Added `jsdom`, `@testing-library/react`/`dom`/`jest-dom`/
  `user-event`. vitest stays node by default; renderer tests opt in via a `// @vitest-environment jsdom`
  docblock. `tests/setup.ts` registers jest-dom matchers; `tests/helpers/renderer.ts` stubs `window.api`
  (a Proxy that auto-`vi.fn()`s un-supplied methods). Coverage: **WorkspaceGate** (password floor +
  confirm, create/unlock branches, plaintext toggle, `{ok:false}` error mapping) and **DocumentsScreen**
  (list/status, the M7 stale-embedding banner, failed-doc error, empty state, delete+refresh).
- **Still untested (accepted):** `main/index.ts` top-level wiring (needs a full Electron mock — better
  for e2e) and the remaining screens (Chat/Models/Settings/Diagnostics/Privacy/Home) — the harness now
  exists to add them incrementally.

---

## 10. Post-Phase-13 code/docs audit remediation (2026-06-09)

A full code + docs audit (three parallel reviewers: docs-vs-code, Phase-13 modules, broader
services/IPC) ran after Phase 13. Docs were found unusually well-synced. Findings fixed in-repo, no
hardware needed. **Typecheck clean, build green (main 104.75 kB), 322/322 tests pass** (was 306 —
+16: `runtime-manager.test.ts` [5] + new Phase-13 coverage in `commercial-drive`/`launcher` tests [11]).

**Real bugs (pre-existing, found by the broad sweep):**
- **B1 (sidecar orphan)** — `LlamaServer.stop()` escalated to `SIGKILL` behind `if (!child.killed)`,
  but `child.killed` is `true` the moment a signal is *sent*, so the escalation was dead code → a
  `llama-server` that ignores `SIGTERM` (mac/Linux) survived the grace window. Now gated on
  `this.exited` (actual exit). Added an injectable `killGraceMs` test seam; regression tests assert
  SIGKILL-on-ignore and no-escalation-on-polite-exit (`runtime-manager.test.ts`).
- **B2 (stale runtime after a failed start)** — `RuntimeManager.start()` left `this.current` pointing
  at a half-started runtime when `start()`/`health()` threw; chat/RAG gate on `active() != null`, so
  requests routed to a server that never came up. Now commits `current`/`last` only on full success,
  stops + resets on failure, and rethrows. Tested (start-throw, health-throw, recover-on-next-start).

**Phase-13 hardening:**
- **P1** — `assertCommercialDrive` user-data check now also rejects `paid.sqlite-wal`/`-shm` (a crash
  can leave plaintext DB pages `cleanSidecars` normally shreds) so the final ship gate doesn't rely on
  `shredStalePlaintext` having run.
- **P2** — the `build-commercial-drive.{ps1,sh}` native posture cross-check was missing the
  `allow_telemetry` check + the `workspace/documents/` and WAL/SHM checks that the canonical TS gate
  enforces; both scripts now mirror `assertCommercialDrive` exactly.
- **P3** — the Windows `.cmd` launcher picked the *last* matching portable `.exe` (no `break`); now
  takes the FIRST match, matching the macOS/Linux launchers' selection.

**Comment/doc accuracy:** `measureTokensPerSecond` now documents it counts *stream chunks* (≈ tokens),
not exact tokens; `preflight.ts` documents the `driveWarnings[0]` coupling to the neutral-profile
branch; `db.ts` "Electron >= 35" → the actual `^37` pin; provisioning-plan §13.1 `.exe` launcher note
→ the shipped `.cmd`; `architecture.md` over-specific "Node 22.21" → "Node 22.x".

**New test coverage added (closing audited gaps):** the `os:'linux'` package step + `formatPlan`
manual-tag-on-package; `assertCommercialDrive` empty-manifests + real-hash *mismatch* + the full
user-data matrix (plaintext DB / descriptor / WAL / SHM / non-empty + empty `documents/`); `runPreflight`
`freeBytes == null`; `resolveDriveRootFromLauncher` UNC + mixed-separator inputs.

**Noted, intentionally NOT changed (low risk / by design):** `runtime_events` table is spec-reserved
but unwritten; the per-import `jobs` Map isn't pruned (tiny, ephemeral); `settings.getSettings` doesn't
type-guard stored JSON (privacy-safe — the network path is double-gated by the policy AND); `expandPaths`
follows directory symlinks; `resolveDriveRootFromLauncher` is a canonical reference module not in the
runtime path (same pattern as `drive.ts`/`assets.ts`). Pervasive "Phase 10 (future)" comment tense left
as-is (describes *where* a swap lives; not worth the churn).

---

## 11. Audit round 4 — Critical/High remediation (2026-06-09)

A fourth five-persona audit (security/privacy · spec-compliance · bug-hunt · docs-vs-code ·
release/build engineering; full report = [`docs/audit-2026-06-09-multi-persona.md`](docs/audit-2026-06-09-multi-persona.md))
found 2 Critical + 7 High findings. **All 9 are FIXED.** Gate: typecheck clean, **343/343 tests pass**
(was 323 — +20 regression tests), build green (main bundle **110.63 kB**). No new dependencies.

**Critical (script↔TS drift in the commercial pipeline):**
- **C1** — `fetch-runtime.{ps1,sh}` key regex was `[A-Za-z_]+` (no digits) → the `sha256:` line never
  parsed → runtime-zip verification was structurally dead (would stay UNVERIFIED even with a real
  committed hash). Fixed (`[A-Za-z0-9_]+`) + the selected build now FAILS LOUDLY if `url`/`sha256`/
  `extract_to` is missing. Verified end-to-end (real hash → VERIFIED; tampered → delete + exit 1).
- **C2** — `build-commercial-drive.{ps1,sh}` step 7 checked posture/user-data but left weights to a
  *manual* instruction (`verify-models` exits 1 only on MISMATCH; MISSING/UNVERIFIED passed) → a
  placeholder-hash drive shipped with exit 0. New **`verify-models -Strict/--strict`** (every weight
  VERIFIED + ≥1 weight, mirroring `assertCommercialDrive.weightsVerified`) is now invoked by step 7;
  any non-VERIFIED weight makes the pipeline exit 1.

**High:**
- **H1 (spec §3.5 hard rule) — encrypted document cache.** Imported document copies used to rest in
  PLAINTEXT under `workspace/documents/` even in an encrypted workspace. Now: ingestion takes an
  optional `DocumentCipher` (`WorkspaceController.documentCipher()`, non-null only for an unlocked
  encrypted vault) → stored copies are `<id><ext>.enc` (same AES-GCM framing/key as the DB); import
  parses the original directly (no plaintext ever lands in the store); re-index decrypts to a
  transient `<id>.parse<ext>` shredded after parsing; a legacy plaintext copy is migrated to `.enc`
  on re-index. `shredStalePlaintext` now also sweeps `*.parse*`/`*.tmp` transients + the DB `.tmp`
  (closing audit M9 too). Docs corrected (READ ME FIRST "encrypts everything" over-promise,
  PRIVACY/SECURITY/security-model/user-guide/drive-layout now state exactly what is/isn't encrypted;
  SECURITY.md's stale scrypt-primary wording → Argon2id default).
- **H2** — `RuntimeManager` start/stop now **serialized** through an internal op queue: a second
  `start()` during a slow GGUF load waits and stops the committed runtime first (no second, orphaned
  `llama-server`); `stop()` during an in-flight start stops what the start commits; quit-during-start
  can no longer leak the child.
- **H3** — `E5Embedder.stop()` now awaits an IN-FLIGHT lazy start and stops whatever it produced, and
  a `stopped` flag prevents a racing `embed()` from resurrecting the sidecar after quit.
- **H4** — vault-wipe guard: `createEncryptedVaultOnDisk` refuses when `.enc` exists;
  `WorkspaceController.create()` refuses while ANY vault artifact exists (valid descriptor, `.enc`,
  or a CORRUPT descriptor — which now reports state **locked**, not `uninitialized`, so the gate
  never offers the create flow that would overwrite the data); `unlock` with a corrupt descriptor +
  intact `.enc` throws a restore-the-descriptor hint. IPC maps the refusal to `{ok:false,
  reason:'refused'}` with the real message.
- **H5** — checksum work no longer thrashes the drive: placeholder-hash weights are decided from the
  manifest alone (NO hashing), and real-hash verification is cached by `(path, size, mtimeMs)`
  (`clearChecksumCache` for tests; ship gates still always hash fully). Models/Chat screen mounts no
  longer re-read multi-GB GGUFs.
- **H6** — the documented zero-weights first-run journey now works: `startRuntime` enforces the spec
  §7.4 gate in the MAIN process (role must be `chat`; state must be `installed`) with ONE exception —
  a `missing` model in developer mode starts the mock via the selecting factory. The Models screen
  shows **Start mock runtime** on missing chat models (dev mode); README/user-guide/troubleshooting
  updated to match (and the embeddings-model-as-chat-runtime hole, audit M8, is closed by the role
  gate).
- **H7** — a commercial drive now ships sidecars for ALL OSes: `build-commercial-drive.{ps1,sh}` loop
  `fetch-runtime` over win/mac/linux (and `planCommercialDrive`'s step says so); `fetch-runtime.ps1`
  derives the binary name from the SELECTED build's OS (was hardcoded `llama-server.exe`) and its
  idempotent skip works cross-OS; an explicit `--os` without `--arch` selects that OS's first build
  (cross-provisioning from any host).

**New regression tests (+20):** runtime-manager serialization (2), e5 stop-during-start (1), vault
create-over-existing/corrupt-descriptor (4), checksum cache + placeholder-no-hash (3),
startRuntime gate (3), encrypted document cache (7, new `encrypted-documents.test.ts`).

**Remaining from the audit (NOT in this round, by scope):** the Medium/Low findings — see the report's
§5/§6 and prioritized list (§8). _(Update: the Medium correctness cluster was fixed in §12 below.)_

---

## 12. Audit round 4 — Medium remediation (2026-06-09)

Follow-up to §11: the audit's Medium correctness cluster (M1–M7, M10, M11; M8/M9 were closed with
§11). Gate: typecheck clean, **355/355 tests pass** (was 343 — +12 regression tests), build green
(main bundle **113.71 kB**). No new dependencies. Both pipeline scripts dry-run-smoke-tested; the
new license-gate parsing validated against the committed manifests in BOTH shells.

- **M1 — regenerate deletes the wrong message.** `deleteLastAssistantMessage` now deletes the
  conversation's LAST message only if it is an assistant turn (after a failed generation the last
  turn is the user's — deleting the most recent assistant message destroyed the answer to a
  *previous* question). The ChatScreen optimistic slice mirrors this.
- **M2 — conversation switch mid-stream corrupted the transcript.** ChatScreen now tracks the
  stream's conversation id: the live bubble renders, and the completion/error refresh applies, only
  when it matches the visible conversation; sidebar + New-chat are disabled while streaming.
- **M3 — per-document concurrency guard.** `registerDocsIpc` keeps a `processing` set: delete/
  re-index are refused while the import loop (or another re-index) is processing that document —
  no more FK violations, duplicate chunk sets, or Windows EBUSY on the stored copy. The
  "never throws" promise of `processDocument` now holds even when the row vanished mid-pipeline
  (`infoOrDeleted` returns a synthetic `deleted` info instead of a TypeError).
- **M4 — lock-while-importing wedge.** The import loop stops cleanly when the vault locks mid-job,
  and the one-shot reconcile flag is gone: `listDocuments` reconciles rows stuck in an active
  status whenever nothing is actually running (no live job, empty `processing` set) — so a
  lock→unlock mid-import leaves re-indexable `failed` rows, not perpetually-disabled "in progress".
- **M5 — vault file crypto >2 GiB.** `encryptFile`/`decryptFile` now STREAM (8 MiB chunks, GCM tag
  patched into the reserved header slot after the stream; same `MAGIC|iv|tag|ct` frame — existing
  vaults unlock unchanged, verified by cross-format tests both directions). `shredFile` overwrites
  in bounded chunks and ALWAYS unlinks (the old `randomBytes(size)` threw past 2 GiB and skipped
  the unlink, leaving the plaintext DB behind). A failed decrypt shreds its partial output.
- **M6 — DOCX confetti chunks.** The chunker pre-coalesces consecutive segments with identical
  `(pageNumber, sectionLabel)` before windowing — DOCX paragraphs now pack into full ~500-token
  chunks (instead of one tiny chunk per paragraph silently hitting the 1000-chunk cap), while PDF
  pages and Markdown sections are untouched (the never-cross-a-boundary invariant holds).
- **M7 — real-E5 context overflow + giant batch + no timeout.** `E5Embedder` truncates each input
  to the sidecar context budget (≈1.4 BPE tokens/word safety ratio; E5-small caps at 512 real
  tokens vs our 500-WORD chunks), embeds in batches of 32, and bounds every request with
  `AbortSignal.timeout(120 s)` — a wedged sidecar fails the document instead of parking it in
  `embedding` forever.
- **M10 — verification gate hardening.** `DEFAULT_SETTINGS.developerMode` is now **false**; a dev
  build (`AppContext.isDev` = `!app.isPackaged`) counts as developer. The drive policy is now
  ENFORCED in-app: `registerModelIpc` computes leniency as
  `(toggle ∨ devBuild) ∧ allow_unverified_models ∧ ¬require_sha256_match` — on a commercial drive
  unverified weights are rejected (and the mock fallback disabled) regardless of the toggle. The
  Models screen's mock affordance now comes from the main process (`ModelInfo.startableAsMock`).
- **M11 — license-review ship gate.** `assertCommercialDrive` gained `checks.licensesApproved`:
  every shipped model's `license_review.status` must be `approved` (spec §13) — NOT overridable by
  `--accept-license` (that is download-time acceptance, not a redistribution review). Both
  `build-commercial-drive.{ps1,sh}` step-7 cross-checks mirror it (flat-parse `status:` from the
  drive manifests; `runtime-sources.yaml` skipped via the no-`local_path` guard). ⇒ With today's
  `pending` manifests a commercial build correctly reports NOT SELLABLE until reviews are done.

**New regression tests (+12):** regenerate-after-failure (1), packing + label-isolation (2), E5
truncation + batching (2), streaming-crypto format compatibility + tamper + shred (4), startRuntime
dev/isDev/policy-veto matrix (3 net), license-gate fail (1), startableAsMock off for non-devs
(folded into the listing test).

**Still open from the audit:** the docs-drift sweep (M25–M31) + the Low findings — tracked in the
report §5/§6. _(Update: closed in §13 below.)_

---

## 13. Audit round 4 — remaining Mediums, Lows & docs sweep (2026-06-09)

The final remediation round: everything still open from the audit. Gate: typecheck clean,
**360/360 tests pass** (was 355 — +5), build green (main bundle **118.87 kB**). No new deps.

**Scripts/packaging (M17–M24 + script Lows):**
- **M17** — all flat-YAML parsers (fetch-models/verify-models/fetch-runtime ×2 shells + the
  license gates) strip inline `# comments` before unquoting (the committed
  `version: b9196  # PLACEHOLDER` no longer leaks into values/filenames).
- **M18** — `fetch-runtime.{ps1,sh}` reject an `extract_to` that escapes the drive root
  (`..`/absolute/drive-letter), mirroring TS `planRuntimeDownload`.
- **M19** — `setup-dev.{ps1,sh}` PROBE `--use-system-ca` before using it (unknown-flag abort on
  Node 22.5–22.14) and APPEND to a pre-existing `NODE_OPTIONS`; `engines` added to
  `apps/desktop/package.json`.
- **M20** — `.gitattributes`: `launchers/*.cmd` + `READ*` are **CRLF** (LF-only batch parsing is
  unsupported cmd.exe territory; these ship verbatim to customer drives). Renormalized.
- **M21** — ONE manifest source of truth: all three launchers export
  `PAID_MANIFESTS_DIR=<drive>/model-manifests` (what the scripts verified is what the app loads);
  `resolveManifestsDir` falls back to the walk-up when an override path is missing. The
  `.command` `open`-fallback (which dropped the env → silent non-drive workspace) now fails with
  a friendly message instead.
- **M22** — every PS script normalizes a relative `-Target` to a full path up front (.NET IO +
  curl.exe resolve against the PROCESS cwd, which ignores `Set-Location`).
- **M23** — bash 3.2 + `set -u`: empty `MANIFEST_FILES` arrays are guarded (an empty
  `model-manifests/` no longer crashes; `verify-models --strict` still exits 1).
- **M24** — the bash posture greps tolerate arbitrary whitespace + note policy.json is
  machine-generated. Lows: stale `.aria2` control files removed on mismatch; `verify-models`
  excludes `runtime-sources.yaml`; Windows-on-ARM arch via `PROCESSOR_ARCHITEW6432`; `.gitignore`
  gains `*.sqlite-wal`/`-shm`.
- **M30** — the broken `lint` scripts (eslint was never installed) removed from both
  package.json files; plan doc corrected (`typecheck` is the static gate).

**App (M12–M16 + SEC/code Lows):**
- **M12** — spec §2.1 "first-run hardware benchmark": a never-benchmarked workspace is
  benchmarked automatically in the background once it becomes usable (plaintext open at startup,
  or unlock/create) — `maybeRunFirstBenchmark` in `registerBenchmarkIpc.ts`.
- **M13** — spec §7.6 "export chat transcript": `exportTranscript` (Markdown, incl. citations) +
  `exportConversation` IPC (OS save dialog in main) + an Export button on the Chat screen.
- **M14** — spec §7.11 Diagnostics completed: app name/version, selected model, hardware profile,
  live runtime status (`getRuntimeStatus` IPC), and a local-log viewer (`getLogTail` IPC, tail of
  `app.log`).
- **M16** — drive detection WITHOUT the launcher: `findPreparedDriveRoot` walks up from the app's
  own location (`PORTABLE_EXECUTABLE_DIR` for the Windows portable target, else the exe dir) to
  the `config/drive.json` marker — a buyer who double-clicks the app directly still lands on the
  drive workspace (an exe in Downloads does NOT create a workspace there: marker required).
- **SEC-B** — descriptor-supplied KDF params are bounds-checked (`keyLen === 32`; argon2id
  `m ≤ 2 GiB`, scrypt power-of-two `N ≤ 2^22`…): a tampered descriptor can no longer turn every
  unlock into a multi-GB allocation. **SEC-C** — the vault key is zeroed (`fill(0)`) on lock.
  **SEC-F** — `updateSettings` persists only known `AppSettings` keys with type-matching values.
- **L1** — non-OK sidecar responses cancel the body (undici connection released). **L2** — a stop
  before the first token persists nothing (no permanent empty assistant bubble); shared
  `emptyAssistantMessage` in chat + RAG. **L5** — a failed backend init shows a fatal-error screen
  instead of faking `unlocked` and surfacing raw IPC errors everywhere.

**Docs sweep (M15, M25–M31 + doc Lows):** offline-guard gating described correctly everywhere
(M27); `architecture.md` updated for Phases 9/11–13 modules, the new IPC, and the module↔spec map
(M28); BUILD_STATE §3/§4 stale "four manifests"/IPC list/runtime-sources-pin claims corrected
(M29); `rag-design.md` embedder mechanism (M31); drive-layout.md documents the spec §6
`updates/`/`backups/`/`runtime/embeddings` divergences + a manual **"Updating a drive"** section
(M15/spec §12.3); README Node version, `manifest.ts` `local_path` comment, user-guide status
label, CLAUDE.md `package` command, PRIVACY.md no-downloader-ships-today caveat, sample-data +
model-manifests READMEs.

---

## 14. Manual-acceptance prep: real llama.cpp pin + license reviews (2026-06-10)

The in-repo half of the manual-acceptance path (BUILD_STATE §5 / audit next-steps 1.1 + 1.4):

- **`runtime-sources.yaml` is PINNED to a REAL release: `ggml-org/llama.cpp@b9585`**, with real
  per-OS asset URLs and SHA-256 checksums computed from the actually-downloaded assets
  (win/x64 cpu zip · mac/arm64 metal tar.gz · linux/x64 cpu tar.gz). R5's "fetch-runtime 404s"
  blocker is gone.
- **Current-release format handled:** the macOS/Linux assets are now `.tar.gz` (not `.zip`) and
  nest everything under `llama-<tag>/`, with `lib*.so`/`.dylib` **version symlinks** inside.
  `fetch-runtime.{ps1,sh}` now: name the archive from the URL basename; extract tar.gz via
  tar (bsdtar on Windows); **flatten** nested layouts so `llama-server[.exe]` lands at
  `runtime/llama.cpp/<os>/`; **materialize symlinks as copies, multi-pass for chains**
  (Windows hosts and exFAT drives cannot hold symlinks); and **exit 1 if the binary is not
  present after extraction** (was a warning). `assets.ts planRuntimeDownload` names the
  archive from the URL too (+ tar.gz test).
- **Corporate-proxy fix:** schannel curl fails CRL/OCSP behind TLS-intercepting proxies
  (`CRYPT_E_NO_REVOCATION_CHECK`); the fetch scripts pass `--ssl-revoke-best-effort`
  (Windows curl always; bash only when `curl --version` reports schannel). Integrity remains
  enforced by the SHA-256 pins.
- **Verified END-TO-END on this machine, both shells:** real download → `archive VERIFIED`
  (hash match) → extraction → flatten → `llama-server[.exe]` at the extract root for **all
  three OSes** from a Windows host; idempotent re-run skips. A tampered hash deletes + fails.
- **License reviews COMPLETED (spec §13, audit M11):** all six manifests are now
  `license_review.status: approved` (reviewed 2026-06-10, Claude-assisted, upstream licenses
  verified via the Hugging Face API): the five Qwen3 GGUF repos are **apache-2.0** (official
  Qwen org quantizations); multilingual-E5's **base model is MIT**. ⚠️ Caveat recorded in the
  E5 manifest notes: the GGUF quant repo (ChristianAzinn) declares no separate license field —
  treated as MIT via the base model (mechanical quantization); re-quantize in-house or switch
  quant source if stricter provenance is wanted before selling. `fetch-models` no longer needs
  `--accept-license`; the commercial license gate now passes.
- Docs updated (README + model-policy placeholder warnings → pinned-release notes).
- Gate: typecheck clean, **361/361 tests**, build green.

**Remaining manual acceptance:** fetch the weights onto the user's prepared drive + promote the
weight hashes (`verify-models --generate`), the live real-model smoke test, `npm run package:win`
+ post-package smoke, certs (R7) + `build-commercial-drive` + the spec §17 USB demo.

**Still open (accepted/architectural):** the spec-gap items that are conscious product decisions —
no full Onboarding wizard (the WorkspaceGate + auto-benchmark + Home cover the §17 flow),
`ChatOptions.mode` Fast/Balanced/Deep stays dead plumbing, `runtime_events` unwritten, no
`sample-contract.pdf` fixture, importDocuments accepts caller paths (picker-only hardening
deferred), and the offline guard remains detection-only. All tracked in the audit report.

---

## 15. Drive-provisioning bug fix: prepare-drive `-WithAssets` arg forwarding (2026-06-10)

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
then `fetch-runtime.ps1 -Target D:\`. This is part of the still-open manual-acceptance path (§14):
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
  + the §13 license-review note (provenance change recorded) in repo + drive manifests.

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
  "escapes the drive root", was caught, and returned null → mock embedder. Fixed by the §15 `weightPath`
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
