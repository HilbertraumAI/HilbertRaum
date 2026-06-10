# Post-MVP Functionality Plan — toward the Office/Knowledge edition

_Status: **IN PROGRESS** — **Phases 17 + 18 IMPLEMENTED** (2026-06-10, deviations in §5.5 /
§6.5); Phases 19–20 not started. Drafted 2026-06-10 from the gap analysis of spec §19 editions
vs. the feature-complete Lite MVP (Phases 0–16). Working paper per the CLAUDE.md doc lifecycle
rule: once implemented, condense to a design record. Section numbers are intended to stay
stable so code comments can cite them._

This plan covers **functionality wave 1** (Phases 17–20, fully specified) and sketches
**wave 2** (Phases 21–22). It deliberately does NOT cover release acceptance — signing certs,
the live USB §17 demo, and the GPU hardware matrix stay tracked in BUILD_STATE §5 and gate the
*release*, not this work.

---

## 1. Summary (the decisions, in one screen)

| Decision | Choice | Why (short) |
|---|---|---|
| Direction | Climb toward **Office/Knowledge Drive** (spec §19.1), not Pro/Studio/Enterprise | Its features have existing hooks in the code; it serves the same target user as Lite |
| Phase 17 | **RAG trust & document-scoped asking** first | The first real-drive test produced a hallucinated answer via the plain-Chat tab (BUILD_STATE §9) — the killer feature fails silently for exactly our target user |
| Chat modes | **Keep** the per-conversation `chat`/`documents` modes (locked DB/IPC contract); add ambient document-awareness + scoping. Unified auto-RAG chat is deferred to the Office edition proper (§13 D1) | Auto-grounding without a reranker/quality floor degrades plain chat; the contract change is big |
| Phase 18 | **In-app model downloader** (revives deferred plan §12.3) | All infrastructure exists (`assets.ts` plan/verify seams, policy + user gates); buyers currently have no path to more models |
| Phase 19 | **Audit log** on the existing `runtime_events` table | Table exists unwritten; first concrete Office/Enterprise compliance feature; cheap |
| Phase 20 | **Answer-depth modes** (Fast/Balanced/Deep) wiring Qwen3 thinking mode | `ChatOptions.mode` + manifest `supports_thinking_mode` are dead plumbing today; spec §10.3 promises the selector |
| Phase 21 (wave 2) | Retrieval quality: **reranker** (+ optional hybrid FTS), ANN only if measured | Needs model-licensing research + a llama.cpp rerank endpoint check first |
| Phase 22 (wave 2) | **Signed offline update bundles** (spec §12.3) | Commercial model monetizes updates; two broken upstream GGUFs already proved the need. Needs a key-management decision |
| New npm deps | **None planned** for Phases 17–20 | Downloads use injected `fetch` (existing seam); audit uses the existing DB; thinking mode is prompt/template control |

**Not in any wave:** OCR (open question #15 — Pro), coding assistant / tool execution (Pro),
image generation (Studio), enterprise policy signing/admin console (Enterprise), cloud
anything (never).

## 2. Hard rules (restated — these bound every choice below)

- **Offline by default, forever.** The downloader (Phase 18) is the app's first sanctioned
  network feature: it must be double-gated (policy ceiling ∧ explicit user opt-in ∧ per-download
  confirmation), default-off, and its absence must change nothing — the app stays 100 % usable
  with no internet, no downloads, no update checks.
- **No telemetry.** The audit log (Phase 19) is *for the user*, stays local (inside the
  possibly-encrypted DB), and must never record message content or document text — ids and
  event types only.
- **Graceful-fallback rule intact.** App launches and the full suite passes with zero models,
  zero binaries, zero network (CI default). Verify-before-trust for every downloaded byte.
- **Locked contracts stay locked:** the Phase-3 streaming contract, the Float32 BLOB encoding,
  per-conversation `mode`, `[Sn]`-labels-per-query-never-stored, localhost-only sidecars.
- **Friendly copy (spec §11.4).** Never "wrong mode", "stale index", "your hardware is bad".
- **Per-phase ritual (CLAUDE.md)** applies to each phase: tests green → build → docs →
  BUILD_STATE → commit.

## 3. Current-state facts this plan builds on (verified in code, 2026-06-10)

- `rag/index.ts` `retrieve()` already threads `RagRetrievalSettings` and constructs
  `VectorIndex` with `VectorIndexOptions { embeddingModelId }` — adding a second scoping
  option is a localized change. The grounding guard (`NO_DOCUMENT_CONTEXT_ANSWER`, model not
  called on empty retrieval) is the no-hallucination anchor and must survive every change.
- `ChatScreen.tsx` fixes mode per conversation (`conversations.mode`), toggle picks the mode
  for the *next* conversation. The hallucination incident happened because nothing tells a
  plain-Chat user that the model cannot see their documents.
- `settings.activeEmbeddingModelId` **stays `null` in practice** (BUILD_STATE §9): the real
  embedder is chosen by availability at startup, and nothing persists its id — which is why
  the Documents screen never warns about mock-indexed (invisible-to-E5) documents.
- `assets.ts` exposes the full downloader logic with an **injected fetch** seam:
  `planModelDownloads` (license gate, present-verified/unverified states), `downloadToFile`
  (`DownloadDeps { fetchImpl, onProgress }`), `fetchAndVerify` (hash mismatch deletes the
  partial + throws). Tests already drive it with a fake fetch — the no-network assertion holds.
- **Policy ceiling today blocks any downloader everywhere:** `DEFAULT_POLICY` denies network,
  `prepare-drive` writes deny in BOTH commercial and dev postures, and effective network =
  policy ∧ user setting. With no policy file, even `allowNetwork: true` does nothing. Phase 18
  cannot ship without resolving §13 D3.
- `runtime_events` table (spec §8) exists since Phase 1: `(id, event_type, message,
  metadata_json, created_at)` — created idempotently, written by nothing.
- `ChatOptions.mode` (`'fast' | 'balanced' | 'deep'`) is accepted over IPC and read by
  nothing; manifest `supports_thinking_mode` is parsed and unused. All four bundled Qwen3 chat
  models declare `supports_thinking_mode: true`.
- The offline guard is installed only when `offlineMode` is true, so a sanctioned download
  session (policy ∧ user allow ⇒ `offlineMode: false`) does not fight it. The Privacy screen
  already renders live network state.

## 4. Phase ordering rationale

17 before 18: the downloader makes models easier to get, but RAG trust is what the product *is*
(spec §23: "ask questions about private documents"). 19 is independent and small — it slots
third because 17/18 generate the most interesting events to record (download started/verified,
reindex, scope changes). 20 is cosmetically independent but benefits from 17's ChatScreen
refactor landing first. Each phase is shippable alone; none blocks release acceptance.

---

## 5. Phase 17 — RAG trust & document-scoped asking

**Goal:** a non-technical user can no longer silently get an ungrounded answer about their
documents, never unknowingly searches a corpus their embedder cannot see, and can ask a
question against a chosen subset of documents (spec §10.4, deferred at MVP).

### 5.1 Document-awareness in plain Chat

When the workspace has ≥ 1 `indexed` document and the conversation is in `chat` mode, the
transcript shows a dismissible, per-conversation inline notice:

> *"This is a plain chat — answers don't use your imported documents. Switch to **Ask
> Documents** to get cited answers from them."* — with a one-click switch that starts a new
> `documents` conversation pre-filled with the composer text.

Renderer-only (one `listDocuments` call on mount, cached); no IPC change. The mode tabs also
gain one-line subtitles ("General assistant" / "Answers from your files, with sources").

### 5.2 Embedder-visibility honesty (the mock→E5 trap)

1. **Persist the active embedder id at startup:** when `createSelectedEmbedder` resolves,
   write its `id` to `settings.activeEmbeddingModelId` post-unlock (mirroring
   `maybeAutoStartActiveModel` — background, never throws). This finally activates the
   existing-but-dormant stale-embeddings gate.
2. **Per-document visibility flag:** `listDocuments` gains `embeddingModelId` (the distinct
   `embeddings.embedding_model_id` for the doc's chunks) and a derived
   `needsReindex: boolean` (≠ active embedder id). Documents screen badges affected rows
   ("Indexed for a different search model") + offers **Re-index all** (sequential
   `reindexDocument` loop, reusing the import-job polling UX).
3. **Ask-Documents preflight:** if every indexed document is invisible to the active embedder,
   the grounded path's empty-corpus answer gets a more actionable variant ("Your documents
   need a quick re-index before they can be searched — open the Documents screen").

### 5.3 Ask selected documents (spec §10.4)

- `VectorIndexOptions` gains `documentIds?: string[]` → the cosine scan adds
  `AND chunk_id IN (SELECT id FROM chunks WHERE document_id IN (…))` (prepared with the right
  arity; empty array = unscoped). Same `search` signature, ANN-upgrade path unaffected.
- `rag.retrieve` accepts an optional scope and threads it through; `askDocuments` IPC gains an
  optional `documentIds` argument (additive — old callers unchanged).
- **Scope persistence (§13 D2):** additive nullable `scope_json` column on `conversations`
  (idempotent `ALTER TABLE` guarded by a pragma check, like existing schema creation). A
  `documents`-mode conversation created from a selection stores it; the ChatScreen shows
  removable scope chips above the composer; reload restores them.
- Documents screen: row checkboxes + an **Ask these documents** action → navigates to Chat in
  `documents` mode with the scope applied (extends the existing `navigate()` /
  `initialMode` plumbing from the UX-polish round).
- Empty-scope retrieval (scoped docs deleted later) falls back to the fixed grounded-path
  answer — the model is still never called without context.

### 5.4 Change inventory (Phase 17)

| File | Change |
|---|---|
| `services/embeddings/index.ts` | `VectorIndexOptions.documentIds`, scoped SQL |
| `services/rag/index.ts` | scope threading in `retrieve`/`generateGroundedAnswer`; actionable empty-corpus variant |
| `services/ingestion/index.ts` | `listDocuments` embedder-id join + `needsReindex` |
| `services/db.ts` | guarded additive `conversations.scope_json` migration |
| `services/chat.ts` | `createConversation` optional scope; scope read helper |
| `main/index.ts` | persist `activeEmbeddingModelId` post-unlock |
| `ipc/registerRagIpc.ts` / `registerChatIpc.ts` / `registerDocsIpc.ts` | additive args |
| `preload` + `shared/types.ts` + `shared/ipc.ts` | additive API/type surface |
| `renderer/screens/ChatScreen.tsx` | plain-chat notice, scope chips, mode subtitles |
| `renderer/screens/DocumentsScreen.tsx` | needs-reindex badge, Re-index all, selection + Ask |
| `docs/rag-design.md`, `user-guide.md`, `known-limitations.md` | update (remove the §10.4 gap) |

### 5.5 As implemented (2026-06-10) — deviations from the plan above

Phase 17 shipped per §5.1–§5.4 with three deviations (full detail in
[`rag-design.md`](rag-design.md) §10; gate: typecheck clean, 499 tests, build green):

1. **§5.2 items 1–2 were partly pre-empted by an earlier polish round** (the
   `staleEmbeddings` flag, the per-document badge, and `listDocuments` scoped to
   `ctx.embedder.id` already existed). Phase 17 added **Re-index all**, the
   `REINDEX_NEEDED_ANSWER` empty-corpus variant, and a **stronger fix than persisting
   `activeEmbeddingModelId`**: ingestion now tags vectors with the id of the embedder that
   actually produced them (`embedder.id` fallback; the settings selection no longer feeds
   the tag). The old tag could stamp mock-produced vectors with the E5 manifest id —
   invisible to mock-scoped search now, poisonous to E5-scoped search later.
2. **`askDocuments` gained no per-call `documentIds` argument** — once the scope persists
   on the conversation (D2a), a per-call arg is redundant; the handler reads
   `conv.scopeDocumentIds`. Scope edits go through the new `updateConversationScope` IPC
   (`chat:updateScope`) instead.
3. The §5.2-3 "actionable empty-scope" copy was folded into the single
   `REINDEX_NEEDED_ANSWER` (the only empty case with a distinct user action).

---

## 6. Phase 18 — In-app model downloader (plan §12.3 revived)

**Goal:** a user with a missing model (e.g. the 8B on a 16 GB machine) can fetch it from the
Models screen — explicit, verified, resumable-ish, and impossible to trigger silently.

### 6.1 Gates (all must hold, in order)

1. `policy.network.allowModelDownloads` (the authoritative ceiling — see §13 D3, **blocking
   decision**: today every generated policy denies this, so the feature would be dead code).
2. `settings.allowNetwork` (the spec §3.6 checkbox, default off).
3. A per-download confirmation dialog showing: model name, size, license + `license_url`,
   the upstream URL, and — when `license_review.status != approved` — an explicit license
   acknowledgement (the in-app mirror of `--accept-license`).

When gate 1 or 2 fails, the Models screen shows *why* ("Downloads are disabled by this
drive's policy" vs. a link to the Settings toggle) — reusing the `PolicyStatus` distinction
the Privacy screen already makes.

### 6.2 Mechanics

- New `ipc/registerDownloadIpc.ts`: `downloadModel(modelId)` → `{ jobId }`,
  `getDownloadJob(jobId)` → `{ status: queued|downloading|verifying|done|failed|cancelled,
  receivedBytes, totalBytes, error? }`, `cancelDownload(jobId)`. **Async-with-polling**, the
  Phase-4 import precedent — no new event channels.
- Implementation reuses `assets.ts` wholesale: `planModelDownloads` (single-id filter) →
  `downloadToFile` with the real `fetch` injected in main + `onProgress` updating the job →
  `verifyDownloadedFile`. Hash mismatch deletes the partial and fails the job (existing
  semantics); placeholder expected hash → job ends `done` but the model stays *UNVERIFIED*
  (checksum honesty, R5) with copy pointing at `verify-models --generate`.
- Download to `<weightPath>.part`, rename into place only after verification — a crashed
  download never leaves a half-weight where `computeInstallState` can see it. Resume via a
  `Range` header when a `.part` exists (best-effort; server without ranges → restart).
- One download at a time (multi-GB on USB; a queue is pointless contention).
- On success: invalidate the checksum cache entry for that path and refresh install state.
- Audit events (once Phase 19 lands): `download_started/verified/failed`.

### 6.3 What this does NOT change

No update checks, no model browsing/catalog (only manifests already on the drive), no runtime
fetching (the sidecar ships at drive-build time), no background anything. The offline guard,
CSP, and `assertOfflinePosture` behavior are unchanged — a sanctioned download session is by
definition not `offlineMode`.

### 6.4 Change inventory (Phase 18)

| File | Change |
|---|---|
| `services/policy.ts` + generated configs | §13 D3 resolution (semantics of the downloads ceiling) |
| `services/downloads.ts` (new) | job state machine over `assets.ts` seams; `.part` + rename; Range resume |
| `ipc/registerDownloadIpc.ts` (new) + preload + shared types/ipc | the three commands |
| `renderer/screens/ModelsScreen.tsx` | Download button + progress + cancel + gate explanations + license confirm |
| `renderer/screens/SettingsScreen.tsx` | surface the §3.6 checkbox copy verbatim |
| `docs/model-policy.md`, `security-model.md`, `PRIVACY.md`, `known-limitations.md` | document the gates; remove the "no in-app downloader" gap |

### 6.5 As implemented (2026-06-10) — deviations from the plan above

Phase 18 shipped per §6.1–§6.4 (gate: typecheck clean, 525 tests, build green; BUILD_STATE §3
has the full entry). Deviations/refinements:

1. **D3 (a) landed exactly as resolved:** `DEFAULT_POLICY.network.allowModelDownloads = true`;
   `prepare-drive` keeps writing deny in **both** its postures (not just commercial) — a dev
   drive's builder lifts it by editing `config/policy.json`, while repo/DIY runs with no policy
   file get the Settings-toggle gate.
2. **`downloadToFile` was extended rather than wrapped** (additive `signal`/`headers`/`append`/
   `onResponse` + a `{status, received, contentLength}` return): resume needs the append
   decision to depend on the server's 206-vs-200 answer, which only the streaming site knows.
   `fetchAndVerify` is not used by the downloader (it has no `.part` staging); the downloader
   composes `downloadToFile` + `verifyDownloadedFile` and replicates mismatch-deletes-partial
   on the `.part`.
3. **`ModelInfo` gained an optional `download` block** (`url`, `sizeBytes`, `licenseUrl`,
   `licenseApproved`) so the confirmation dialog needs no fourth IPC command; the IPC surface
   stayed exactly `downloadModel`/`getDownloadJob`/`cancelDownload`.
4. **`planModelDownloads` gained an optional `hashStore`** so a present-but-mismatched weight
   re-check reads the persisted checksum cache instead of re-hashing multi-GB files.
5. Audit events (§6.2 last bullet) remain for Phase 19, as planned. Accepted cosmetic edge
   recorded in `known-limitations.md`: the startup-installed (detection-only) offline tripwire
   is not re-evaluated mid-session, so a download sanctioned in the same session logs a
   remote-connection notice.

---

## 7. Phase 19 — Audit log (`runtime_events` finally written)

**Goal:** the user can answer "what did this app do, when" without reading `app.log` — the
first Office/Enterprise (§19.1/§19.4) compliance feature.

- New `services/audit.ts`: `recordEvent(db, type, message, metadata?)` (never throws — an
  audit failure must never break the operation it records) + a typed `AuditEventType` union:
  `runtime_started/stopped/crashed/fallback`, `model_selected/verified/download_*`,
  `document_imported/reindexed/deleted`, `conversation_deleted/exported`,
  `workspace_created/unlocked/locked/unlock_failed`, `settings_changed` (privacy-relevant
  keys only: `allowNetwork`, `gpuMode`, `developerMode`), `policy_warning`,
  `offline_guard_violation`.
- **Privacy rule (hard):** `message`/`metadata_json` carry ids, model ids, filenames, and
  counts — never chat content, document text, or passwords. A unit test greps recorded
  fixtures for seeded sentinel content.
- Retention: prune to the newest `AUDIT_MAX_ROWS` (default 5 000) on insert — bounded table,
  no vacuum ceremony. Lives in the workspace DB ⇒ encrypted at rest on encrypted workspaces,
  exactly like chats.
- Surface: Diagnostics gains an **Activity** panel (`getAuditEvents(limit, beforeId?)` IPC,
  newest-first, type filter) + an export-to-file action via the existing save-dialog pattern.
  Nothing uploads anywhere (spec §7.11).
- Wiring is deliberately shallow: call sites in the IPC layer + `RuntimeManager`/ladder +
  `WorkspaceController`, not deep inside services — keeps services pure/testable.

---

## 8. Phase 20 — Answer-depth modes (Fast / Balanced / Deep)

**Goal:** wire the dead `ChatOptions.mode` plumbing into something real: Qwen3's native
thinking mode for **Deep**, a snappier configuration for **Fast**. The spec §10.3 mode
selector finally exists.

- **Mapping (proposed, §13 D4):** `fast` → thinking off + `temperature 0.7`, modest
  `maxTokens`; `balanced` (default) → thinking off, current defaults; `deep` → thinking ON —
  only offered when the active model's manifest has `supports_thinking_mode: true`.
- **Mechanism (research-then-build, §13 D5):** preferred = `chat_template_kwargs:
  { enable_thinking }` on the `/v1/chat/completions` request, **verify b9585 supports it**;
  fallback = Qwen3's documented `/think` · `/no_think` soft switches appended to the user
  turn. Either way the change is localized to `LlamaRuntime.chatStream` request building +
  `RuntimeChatOptions`.
- **Reasoning display:** thinking output (separate `reasoning_content` deltas or inline
  `<think>…</think>` depending on `--reasoning-format`) renders as a collapsed "Thinking…"
  block in the assistant bubble, is **stripped when building history messages** (Qwen
  guidance: never feed think blocks back), and §13 D6 decides whether it persists to the DB.
- Mode selector lives in the composer, per-conversation-sticky like `mode`
  (`ChatOptions.mode` is already per-message over IPC — no contract change). MockRuntime
  ignores it (already true).
- RAG interaction: `askDocuments` stays `balanced` in this phase (grounded answers should be
  fast + literal; deep-grounded is a wave-2 question).

---

## 9. Phase 21 (wave 2, outline) — Retrieval quality: reranker + hybrid search

Not specified yet; gated on research the same way the GPU plan gated on b9585 facts:

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

## 11. Testing strategy

- **CI stays zero-network/zero-model/zero-GPU.** Downloader tests drive `downloads.ts` with
  the existing fake-`fetch` seam (progress, mismatch-deletes-partial, cancel, `.part` rename,
  gate refusals); the no-network assertion is extended to prove `downloadModel` refuses when
  either gate is closed.
- **Unit:** scoped `VectorIndex` SQL (in-memory DB), scope threading through `retrieve`,
  `needsReindex` derivation, audit privacy grep + retention pruning, mode→request mapping
  (`chat_template_kwargs` / soft-switch fallback), think-block stripping from history.
- **Renderer (vitest, `apps/desktop` workspace):** plain-chat notice appears/dismisses, scope
  chips render + remove, Models download button gate states, Deep hidden when
  `supports_thinking_mode` is false.
- **Manual acceptance (appended to BUILD_STATE §5 per phase):** real download of the 4B on
  the `D:\` drive incl. a mid-download cancel + resume; the §5.2 mock→E5 re-index flow on the
  existing test drive; a real Deep-mode answer with visible thinking from Qwen3 4B; an
  Ask-selected run against two PDFs where only one contains the answer.

## 12. Docs impact per phase

17: `rag-design.md`, `user-guide.md` (Ask-selected walkthrough), `known-limitations.md`
(remove §10.4 + stale-embeddings gaps). 18: `model-policy.md`, `PRIVACY.md`,
`security-model.md` (new network surface + gates), `user-guide.md`. 19: `security-model.md`
(audit data class), `architecture.md`. 20: `user-guide.md` (mode explanations, §11.4-tone
copy), `model-policy.md` (`supports_thinking_mode` now load-bearing).

## 13. Decisions (review round 1 — resolved 2026-06-10, operator approved the recommendations)

| # | Decision | Resolution |
|---|---|---|
| D1 | Unify chat into one auto-RAG mode? | **RESOLVED (a):** keep two modes + the plain-chat document-awareness notice for wave 1; revisit unified auto-RAG with Phase-21 quality data |
| D2 | Scope persistence | **RESOLVED (a):** additive nullable `conversations.scope_json` column (guarded `ALTER TABLE`) — survives reload |
| D3 | Downloads policy semantics (was blocking Phase 18) | **RESOLVED (a):** flip `DEFAULT_POLICY.network.allowModelDownloads` to true so the spec §3.6 user toggle is the sole gate when no policy file restricts; commercial `prepare-drive` posture keeps writing deny. Preserves "policy only restricts" |
| D4 | Fast/Balanced/Deep parameter mapping | **OPEN** — decide at Phase 20 start with measured tok/s from the release matrix |
| D5 | Thinking-mode mechanism | **OPEN** — verify b9585 `chat_template_kwargs` support at Phase 20 start; kwargs preferred (soft switches leak into transcripts) |
| D6 | Persist reasoning text? | **RESOLVED (a):** strip before persisting; the collapsed "Thinking…" block is a live-stream affordance only |
| D7 | Audit retention default | **RESOLVED:** fixed 5 000 rows for wave 1; configurability is Office-edition admin surface |
