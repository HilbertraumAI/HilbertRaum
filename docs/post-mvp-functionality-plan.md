# Post-MVP Functionality — wave 1 design record (Phases 17–20) + wave 2 outlines

_Status: **WAVE 1 IMPLEMENTED** (Phases 17 + 18 + 19 + 20, all 2026-06-10). This is the
**condensed design record** per the CLAUDE.md doc lifecycle rule: the decisions, the facts
they rest on, and the design as built — the full original working paper (gap analysis,
change inventories, phase ordering rationale, pre-implementation state) lives in git history:
`git show 2a46ca3:docs/post-mvp-functionality-plan.md`. Section numbers are stable; code
comments cite them (plan §5.1–§5.3, §6.1–§6.2, §7, §8, §13 D1–D7). Wave 2 (§9–§10) is
outline-only and NOT implemented._

---

## 1. Summary (the decisions, in one screen)

| Decision | Choice | Why (short) |
|---|---|---|
| Direction | Climb toward **Office/Knowledge Drive** (spec §19.1), not Pro/Studio/Enterprise | Its features had existing hooks in the code; it serves the same target user as Lite |
| Phase 17 | **RAG trust & document-scoped asking** first | The first real-drive test produced a hallucinated answer via the plain-Chat tab (BUILD_STATE §9) — the killer feature failed silently for exactly our target user |
| Chat modes | **Keep** the per-conversation `chat`/`documents` modes (locked DB/IPC contract); add ambient document-awareness + scoping. Unified auto-RAG chat deferred (§13 D1) | Auto-grounding without a reranker/quality floor degrades plain chat; the contract change is big |
| Phase 18 | **In-app model downloader** (revived provisioning-plan §12.3) | All infrastructure existed (`assets.ts` plan/verify seams, policy + user gates); buyers had no path to more models |
| Phase 19 | **Audit log** on the existing `runtime_events` table | Table existed unwritten; first concrete Office/Enterprise compliance feature; cheap |
| Phase 20 | **Answer-depth modes** (Fast/Balanced/Deep) wiring Qwen3 thinking mode | `ChatOptions.mode` + manifest `supports_thinking_mode` were dead plumbing; spec §10.3 promises the selector |
| Phase 21 (wave 2) | Retrieval quality: **reranker** (+ optional hybrid FTS), ANN only if measured | Needs model-licensing research + a llama.cpp rerank endpoint check first |
| Phase 22 (wave 2) | **Signed offline update bundles** (spec §12.3) | Commercial model monetizes updates; two broken upstream GGUFs already proved the need. Needs a key-management decision |
| New npm deps | **None added** in Phases 17–20 | Downloads use the injected-`fetch` seam; audit uses the existing DB; thinking mode is request/template control |

**Not in any wave:** OCR (Pro), coding assistant / tool execution (Pro), image generation
(Studio), enterprise policy signing/admin console (Enterprise), cloud anything (never).

## 2. Hard rules (these bound every choice)

- **Offline by default, forever.** The downloader is the app's first sanctioned network
  feature: triple-gated (policy ceiling ∧ explicit user opt-in ∧ per-download confirmation),
  default-off, and its absence changes nothing — the app stays 100 % usable with no internet.
- **No telemetry.** The audit log is *for the user*, stays local (inside the
  possibly-encrypted DB), and never records message content or document text — ids and event
  types only.
- **Graceful-fallback rule intact.** App launches and the full suite passes with zero models,
  zero binaries, zero network (CI default). Verify-before-trust for every downloaded byte.
- **Locked contracts stay locked:** the Phase-3 streaming contract, the Float32 BLOB encoding,
  per-conversation `mode`, `[Sn]`-labels-per-query-never-stored, localhost-only sidecars.
- **Friendly copy (spec §11.4).** Never "wrong mode", "stale index", "your hardware is bad".

## 3. Facts the wave-1 design rests on

(As-built; the pre-implementation gap list is in the git-history original.)

- The grounding guard is the no-hallucination anchor: when retrieval yields no usable chunks
  the model is **not called** — a fixed answer is persisted (`NO_DOCUMENT_CONTEXT_ANSWER`,
  or `REINDEX_NEEDED_ANSWER` when the corpus is invisible to the active embedder).
- Retrieval is scoped to the **active embedder's id**; ingestion tags vectors with the id of
  the embedder that actually produced them (Phase 17 vector-tag rule — tag and search scope
  come from the same place).
- Effective network = policy ceiling ∧ user setting; a policy can only restrict. Since
  Phase 18, `DEFAULT_POLICY.network.allowModelDownloads = true` so the spec §3.6 Settings
  toggle (default OFF) is the gate when no policy file restricts; `prepare-drive` still
  writes deny in both postures (§13 D3).
- `runtime_events` (spec §8 schema, created since Phase 1) is the audit table — no schema
  change was needed for Phase 19.
- The chat runtime is the pinned **llama.cpp b9585** `llama-server` over loopback; Phase-20
  facts verified against that tag's source are recorded in §8 and BUILD_STATE §3.

## 4. Phase ordering rationale

Historical — see the git-history original. (Short: trust before reach; 19 slots third because
17/18 generate the most interesting events; 20 benefits from 17's ChatScreen refactor.)

---

## 5. Phase 17 — RAG trust & document-scoped asking (IMPLEMENTED)

**Goal:** a non-technical user can no longer silently get an ungrounded answer about their
documents, never unknowingly searches a corpus their embedder cannot see, and can ask against
a chosen subset of documents (spec §10.4). **The fuller design record lives in
[`rag-design.md`](rag-design.md) §10**; the stable anchors below are what code comments cite.

### 5.1 Document-awareness in plain Chat

With ≥ 1 indexed document, a `chat`-mode conversation shows a dismissible per-conversation
notice ("This is a plain chat — answers don't use your imported documents…") with a one-click
switch to Ask Documents; the mode tabs carry subtitles. Renderer-only.

### 5.2 Embedder-visibility honesty (the mock→E5 trap)

Per-document `staleEmbeddings` badge + **Re-index all** (sequential `reindexDocument` loop)
on the Documents screen; `corpusNeedsReindex` drives the actionable
`REINDEX_NEEDED_ANSWER` empty-corpus variant ("re-index", not "rephrase") — the model is
still never called without context. The vector-tag rule (§3 above) is the underlying fix.

### 5.3 Ask selected documents (spec §10.4)

`VectorIndexOptions.documentIds` scopes the cosine scan (placeholder SQL, composes with the
embedder-id filter); the scope **persists on the conversation** (`conversations.scope_json`,
additive nullable column, guarded `ALTER TABLE` — §13 D2; malformed JSON reads back null).
`createConversation` accepts a scope; `updateConversationScope` (`chat:updateScope`)
replaces/clears it; `askDocuments` reads it from the conversation. UI: Documents-screen
checkboxes → "Ask these documents (N)" → Chat with removable scope chips; empty-scope
retrieval falls back to the fixed grounded-path answer.

### 5.5 As-implemented deviations (2026-06-10)

(1) Ingestion tags vectors with the **producing** embedder's id — stronger than the planned
"persist `activeEmbeddingModelId`" (a wrong settings tag could poison E5-scoped search).
(2) `askDocuments` gained **no per-call `documentIds` arg** — redundant once the scope
persists on the conversation; edits go through `updateConversationScope`. (3) The
"actionable empty-scope" copy folded into the single `REINDEX_NEEDED_ANSWER`. Gate at ship:
499 tests.

---

## 6. Phase 18 — In-app model downloader (IMPLEMENTED; provisioning-plan §12.3 revived)

**Goal:** a user with a missing model can fetch it from the Models screen — explicit,
verified, resumable-ish, impossible to trigger silently.

### 6.1 Gates (all enforced in MAIN, re-checked per call)

1. `policy.network.allowModelDownloads` — the authoritative ceiling (§13 D3 resolved (a):
   default-policy true; `prepare-drive` writes deny in both postures, so prepared drives stay
   download-disabled unless the builder edits `config/policy.json`).
2. `settings.allowNetwork` — the spec §3.6 checkbox, default off; a locked workspace reads
   as off.
3. A per-download confirmation: model name, size, license + `license_url`, upstream URL, and
   an explicit license acknowledgement when `license_review.status != approved` (the in-app
   `--accept-license`). The renderer dialog is UX; enforcement is main-side.

When gate 1 or 2 fails the Models screen says *why* (policy vs. Settings toggle), reusing the
`PolicyStatus` distinction.

### 6.2 Mechanics (as built)

`services/downloads.ts` `DownloadManager` — a job state machine over the REUSED `assets.ts`
seams (`planModelDownloads` + optional `hashStore`, `downloadToFile`, `verifyDownloadedFile`):
bytes land in `<weightPath>.part`, renamed into place ONLY after the hash verifies; a mismatch
deletes the partial and fails the job; a placeholder expected hash completes `unverified`
(checksum honesty, R5). Cancel keeps the `.part`; the next start resumes via a `Range` header
(append iff the server answered 206). One download at a time; jobs are in-memory
(async-with-polling IPC `downloads:start/get/cancel` — the Phase-4 import precedent, no new
event channels). On success the checksum-cache entry is invalidated. Audit events
`model_download_started/verified/failed` flow through an injected `DownloadManagerDeps.audit`
hook (Phase 19); a placeholder-hash completion records NO "verified".

No update checks, no catalog (only manifests already on the drive), no background anything;
a sanctioned download session is by definition not `offlineMode`.

### 6.5 As-implemented deviations (2026-06-10)

(1) D3 landed exactly as resolved. (2) `downloadToFile` was **extended, not wrapped**
(additive `signal`/`headers`/`append`/`onResponse` + a result object) — resume needs the
append decision at the streaming site. (3) `ModelInfo` gained an optional `download` block so
the confirmation needs no fourth IPC. (4) `planModelDownloads` reads the persisted checksum
cache via an optional `hashStore`. (5) Accepted cosmetic edge in `known-limitations.md`: the
startup offline tripwire isn't re-evaluated mid-session. Gate at ship: 525 tests.

---

## 7. Phase 19 — Audit log on `runtime_events` (IMPLEMENTED)

**Goal:** the user can answer "what did this app do, when" without reading `app.log` — the
first Office/Enterprise (§19.1/§19.4) compliance feature. **For the user, not telemetry**:
lives in the workspace DB (encrypted at rest on encrypted workspaces), never uploaded.

- `services/audit.ts`: `recordEvent(db, type, message, metadata?)` **never throws**; typed
  `AuditEventType` union (`shared/types.ts`); `listAuditEvents` (newest-first, `beforeId`
  cursor); retention = prune-on-insert to `AUDIT_MAX_ROWS` = 5 000 (§13 D7).
- **Privacy rule (hard, sentinel-grep-tested):** rows carry ids, model ids, filenames,
  counts — NEVER chat content, document text, or passwords. `conversation_exported` records
  the id only (the filename derives from the title = chat content); `settings_changed` fires
  only for privacy-relevant keys (`allowNetwork`, `gpuMode`, `developerMode`).
- Wiring is **shallow** (IPC layer + `main/index.ts`; services stay pure). Surface:
  Diagnostics **Activity** panel (type filter, `beforeId` paging) + JSON export via the
  save-dialog pattern (`audit:list` / `audit:export`).

### 7.1 As-implemented refinements (2026-06-10)

(1) `createAuditRecorder(getDb)` → optional `AppContext.audit`: **buffers (bounded 100) while
the vault is locked** and flushes with original timestamps — how `workspace_unlock_failed`
ever reaches the encrypted log. (2) Download events go through the injected manager hook
(service stays DB-free). (3) `runtime_crashed`/`runtime_fallback` wire in `main/index.ts`
(the Phase-15 callbacks); `policy_warning` records startup `loadPolicy` warnings;
`offline_guard_violation` uses the additive `assertOfflinePosture.onViolation` hook.
Gate at ship: 542 tests. Data classification lives in [`security-model.md`](security-model.md).

---

## 8. Phase 20 — Answer-depth modes Fast / Balanced / Deep (IMPLEMENTED)

**Goal:** wire the dead `ChatOptions.mode` plumbing into something real: Qwen3's native
thinking mode for **Deep**, a snappier configuration for **Fast**. The spec §10.3 selector
exists. Mechanism doc: [`architecture.md`](architecture.md) "Answer-depth modes"; user copy:
[`user-guide.md`](user-guide.md) §6; manifest flag: [`model-policy.md`](model-policy.md).

- **Mapping (§13 D4, one site — `requestParamsForMode` in `runtime/llama.ts`):**
  `fast` → thinking off + temperature 0.7 + `max_tokens` 1024 · `balanced` AND omitted →
  thinking off, server/model defaults · `deep` → thinking ON + temperature 0.6, uncapped.
  Explicit `RuntimeChatOptions.maxTokens`/`temperature` win over mode-derived values.
- **Mechanism (§13 D5, verified against the pinned b9585 SOURCE):** per-request
  `chat_template_kwargs: { enable_thinking: <bool> }` on `/v1/chat/completions`
  (server-common.cpp L1074–1088). It only acts in the jinja template path — the b9585 server
  default — and reasoning is extracted into SEPARATE `delta.reasoning_content` streaming
  frames (deepseek reasoning format, the default). Both preconditions are pinned in code:
  every CHAT sidecar spawns with `CHAT_SERVER_ARGS = ['--jinja', '--reasoning-format',
  'deepseek']` (E5 embedder excluded). The Qwen3 `/think`·`/no_think` soft switches were NOT
  needed (they leak into transcripts).
- **Reasoning display:** `RuntimeChatOptions.onReasoning(delta)` → the ADDITIVE
  `chat:reasoning:<id>` event channel (preload `onReasoning`) → a collapsed live "Thinking…"
  `<details>` block on the streaming bubble. The locked Phase-3 token contract is untouched
  (token events carry answer text only); MockRuntime ignores mode + onReasoning.
- **D6 (strip everywhere):** `stripThinkBlocks` (`services/chat.ts`) scrubs
  `<think>…</think>` (incl. an unclosed trailing block from a mid-thought Stop) from
  assistant content before persisting — chat AND grounded paths; an all-think aborted reply
  persists nothing — and from assistant turns replayed as history (never feed think blocks
  back). Defense-in-depth: the deepseek format keeps normal output tag-free.
- **Deep gating:** manifest `supports_thinking_mode` → `ModelManifest.supportsThinkingMode`
  (optional boolean, default false) → `RuntimeStatus.supportsThinkingMode` (enriched by
  `getRuntimeStatus` for the RUNNING model only) → the composer offers Deep only when true.
  Selector lives in the composer, chat mode only, sticky per conversation per session
  (per-message over IPC, enum-guarded in the handler; NOT persisted to the DB).
- **RAG interaction:** `askDocuments` never passes a mode — document answers always run
  balanced (deep-grounded is a wave-2 question).

### 8.1 As implemented (2026-06-10) — notes

1. **Research finding that shaped D4/D5:** at b9585, `--reasoning auto` (the default) turns
   thinking ON for every capable template (server-context.cpp L1237–1239) — the bundled
   Qwen3 models were ALREADY thinking on every reply and the app silently dropped those
   deltas (pure latency; the gpu-smoke's `/no_think` workaround was the tell). So
   `enable_thinking` is ALWAYS sent explicitly; `balanced`/omitted = `false`.
2. **D4 was resolved without the release-matrix tok/s** (matrix still pending release
   acceptance): values come from Qwen3's model-card sampling guidance; tune when it lands.
3. Deep gating rides `RuntimeStatus` rather than `ModelInfo` — the Chat screen already polls
   runtime status, and `listModels` hashing stays off that path.
4. **No new audit events** (a mode choice is chat-adjacent state; the Phase-19 privacy
   surface is unchanged). NEW manual harness `tests/manual/thinking-smoke.test.ts`
   (`PAID_THINKING_SMOKE=<drive root>`, gpu-smoke pattern) proves the mechanism live; CI
   stays zero-network/zero-model. Gate at ship: 572 tests, typecheck clean, build green.

---

## 9. Phase 21 (wave 2, outline) — Retrieval quality: reranker + hybrid search

**IMPLEMENTED 2026-06-10** — the research gates resolved and the design + as-built record
live in [`retrieval-quality-plan.md`](retrieval-quality-plan.md) (decisions D8–D15) and
[`rag-design.md`](rag-design.md) §11. Items 1–3 below shipped (item 3 as a pending
measurement: the floor's semantics are decided, the value awaits a real corpus); item 4
(ANN) was explicitly NOT built (D15). The original outline, as the research was gated:

1. **Reranker** (Office §19.1; spec §3.3 reserved the manifest role): verify the pinned
   llama.cpp b9585 `llama-server --rerank` + `/v1/rerank` endpoint works with a candidate
   GGUF; candidates to license-review: `bge-reranker-v2-m3` (Apache-2.0) /
   `Qwen3-Reranker-0.6B` (Apache-2.0). Architecture: rerank the `topKInitial` hits between
   retrieval and dedup — a third sidecar pinned to CPU like E5, behind a `Reranker`
   interface with a pass-through default (no model ⇒ today's behavior, graceful-fallback
   rule).
2. **Hybrid keyword + vector retrieval:** verify Electron's bundled SQLite ships FTS5; if so,
   an FTS index over `chunks.text` + reciprocal-rank fusion is a zero-dep quality win,
   especially for exact terms (invoice numbers, names) that embeddings miss.
3. **Real similarity floor:** with E5 scores in hand from the drive testing, raise
   `ragMinSimilarity` from 0 to a measured default.
4. **ANN index:** only if a real corpus measurably outgrows the linear scan — sqlite-vec/HNSW
   are native deps (against the project theme), so this needs evidence first.

## 10. Phase 22 (wave 2, outline) — Signed offline update bundles (spec §12.3)

A signed bundle (manifests + optionally weights/runtime/app) dropped into `updates/incoming/`,
verified (ed25519 via the already-shipped `@noble` family — no new dep class), applied
atomically, recorded in `updates/applied/` + the audit log. Blocking decision: **key
management** (who holds the signing key, rotation, and whether DIY drives trust a repo key) —
needs its own short design doc before any code. The commercial pitch ("signed update
bundles", spec §1.3) makes this the first post-wave-1 priority once drives actually ship.

---

## 11. Testing posture (wave 1, as held)

**CI stays zero-network/zero-model/zero-GPU** — every wave-1 feature is driven through the
existing harnesses (fake `fetch`, fake spawn + mocked loopback SSE, temp DBs, fake `ipcMain`,
jsdom + stubbed preload api). Manual harnesses behind env vars: `PAID_GPU_SMOKE`,
`PAID_THINKING_SMOKE`. **Manual acceptance: all items completed 2026-06-10** (in-app 4B
download on `D:\` incl. mid-download cancel → resume, user-confirmed; real Deep-mode answer
with visible thinking, smoke + live-UI confirmed; citations/source panel + fully-offline run
confirmed) — **except the Diagnostics Activity-panel eyeball**, still tracked in
BUILD_STATE §5 item 2.

## 12. Docs impact

Applied per phase (historical detail in the git-history original). Durable homes now:
`rag-design.md` §10 (17) · `model-policy.md` + `security-model.md` + `PRIVACY.md` (18) ·
`security-model.md` + `architecture.md` (19) · `architecture.md` + `user-guide.md` §6 +
`model-policy.md` (20) · `known-limitations.md` (accepted edges, all phases).

## 13. Decisions (review round 1 resolved 2026-06-10; D4/D5 resolved at Phase 20 start)

| # | Decision | Resolution |
|---|---|---|
| D1 | Unify chat into one auto-RAG mode? | **RESOLVED (a):** keep two modes + the plain-chat document-awareness notice for wave 1; revisit unified auto-RAG with Phase-21 quality data |
| D2 | Scope persistence | **RESOLVED (a):** additive nullable `conversations.scope_json` column (guarded `ALTER TABLE`) — survives reload |
| D3 | Downloads policy semantics (was blocking Phase 18) | **RESOLVED (a):** flip `DEFAULT_POLICY.network.allowModelDownloads` to true so the spec §3.6 user toggle is the sole gate when no policy file restricts; commercial `prepare-drive` posture keeps writing deny. Preserves "policy only restricts" |
| D4 | Fast/Balanced/Deep parameter mapping | **RESOLVED (2026-06-10, Phase 20):** fast → thinking off + temp 0.7 + max_tokens 1024 · balanced/omitted → thinking off + server defaults · deep → thinking ON + temp 0.6 uncapped (Qwen3 model-card sampling; release-matrix tok/s pending — tune then if needed). Explicit options win. Single mapping site: `requestParamsForMode` (`runtime/llama.ts`) |
| D5 | Thinking-mode mechanism | **RESOLVED (a) (2026-06-10, Phase 20):** per-request `chat_template_kwargs: { enable_thinking }` — support verified in the pinned b9585 SOURCE (server-common.cpp L1074–1088). Requires jinja (b9585 default, pinned via `CHAT_SERVER_ARGS`); reasoning arrives as separate `delta.reasoning_content` frames (`--reasoning-format deepseek`). Soft switches rejected (transcript leakage). NB: b9585 defaults to thinking ON for capable templates → the kwarg is ALWAYS sent |
| D6 | Persist reasoning text? | **RESOLVED (a):** strip before persisting; the collapsed "Thinking…" block is a live-stream affordance only. Enforced by `stripThinkBlocks` on persist AND on replayed history |
| D7 | Audit retention default | **RESOLVED:** fixed 5 000 rows for wave 1; configurability is Office-edition admin surface |

---

## History

- Full original working paper (drafted 2026-06-10; gap analysis, change inventories, §4
  ordering rationale, per-phase specs as written before implementation):
  `git show 2a46ca3:docs/post-mvp-functionality-plan.md`.
- Phase commits: 17 `ef4c08d` · 18 `7782e4d` · 19 `f1e7b92` · 20 `2a46ca3`.
