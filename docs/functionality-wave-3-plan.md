# Post-MVP Functionality — wave 3 design record (Phases 31–38, COMPLETE)

_Status: **DESIGN RECORD — the wave is COMPLETE (Phases 31–38 ALL DONE 2026-06-11).**
§4–§11 are the per-phase condensed design records; every decision in §13 is resolved
and every research gate in §14 carries its banked findings. Per the CLAUDE.md doc
lifecycle rule, this working paper was retired into the durable record when Phase 38
closed the wave (2026-06-11): the as-built mechanisms live in the topic docs
(`architecture.md`, `drive-layout.md`, `model-policy.md`, `security-model.md`,
`user-guide.md`, `known-limitations.md`, `PRIVACY.md`); this file keeps the decisions,
the facts they rest on, the §-anchors BUILD_STATE cites, and the research-gate
evidence. The full original plan (drafted 2026-06-10, review round 1 + plan audit
2026-06-11) is in git history. Phases 29–30 are reserved by
[`model-catalog-expansion-plan.md`](model-catalog-expansion-plan.md); this wave starts
at **Phase 31**. Decisions continue the project-wide numbering at **D23** (D1–D7
wave 1 · D8–D15 retrieval · D16–D22 catalog · D-UI1–4 UI wave)._

The eight features (user-selected 2026-06-10):

| Phase | Feature | Size | Hard dependency | New deps / sidecars |
|---|---|---|---|---|
| 31 | Conversation search — **✅ DONE 2026-06-11** | S | none | none (FTS5 already proven) |
| 32 | Vault password change — **✅ DONE 2026-06-11** | M | none | none (`@noble/hashes` already shipped) |
| 33 | Document tasks foundation + one-click summary — **✅ DONE 2026-06-11** | M | none | none |
| 34 | Document translation workflow — **✅ DONE 2026-06-11** | S–M | Phase 33 (task machinery) | none |
| 35 | Compare two documents — **✅ DONE 2026-06-11** | M | Phase 33 (task machinery) | none |
| 36 | Audio transcription as ingestion (whisper.cpp) — **✅ DONE 2026-06-11** | L | research gates R-W1..R-W4 (all resolved) | **whisper.cpp sidecar family + whisper GGML weights** |
| 37 | Voice dictation in the composer — **✅ DONE 2026-06-11** | S–M | Phase 36 (transcriber) | none beyond 36 |
| 38 | Scanned-PDF / photo OCR — **✅ DONE 2026-06-11** | M–L | research gates R-O1..R-O3 (all resolved) | **tesseract.js (WASM, pinned npm dep) + vendored traineddata (`ocr/` asset class)** |

**Recommended serial order: 31 → 32 → 33 → 34 → 35 → 36 → 37 → 38.** Rationale in §3.
If two tracks can run in parallel: track A = 31–35 (pure DB/LLM/UI work on existing
infrastructure), track B = 36–38 research gates first, then implementation (new runtime
distribution + new asset classes — the long poles).

---

## 1. Hard rules inherited (bound every choice below)

- **Offline by default, forever.** Whisper binaries/weights and OCR language data are
  provisioned like every other asset: build-time fetch scripts or the triple-gated Phase-18
  in-app downloader — **never** fetched silently at runtime. tesseract.js's default
  CDN-loading behavior must be fully disabled (R-O2).
- **No telemetry. Audit privacy rule intact:** events carry ids/filenames/counts, never
  content — search queries, summaries, translations, transcripts are all CONTENT.
- **Graceful-fallback rule:** app launches and the full suite passes with zero models, zero
  binaries, zero network. A missing transcriber/OCR pack degrades to a friendly per-file
  failure, never a crash or a scary dialog.
- **Locked contracts stay locked:** Phase-3 streaming, Float32 BLOB encoding, per-conversation
  `mode`, `[Sn]`-per-query-never-stored, localhost-only sidecars, async-with-polling jobs.
- **Friendly copy (spec §11.4):** "Transcribing…", never "ffmpeg error"; "This PDF looks like
  a scan", never "no text layer found".
- **No new native npm deps.** tesseract.js is WASM (pure-JS theme); whisper.cpp is a prebuilt
  sidecar like llama.cpp, not an npm dep.

## 2. Facts the plan rests on (verified in code 2026-06-10; independently re-verified by the 2026-06-11 audit)

1. **FTS5 is proven in both runtimes** (retrieval-plan §1.2: Electron 37 main process AND
   system Node 24, SQLite 3.50.4 `ENABLE_FTS5`). `chunks_fts` exists as a self-contained
   `fts5(text, chunk_id UNINDEXED)` with three sync triggers + guarded backfill
   (`db.ts`; design rationale D13). `buildFtsMatchQuery` (`services/rag/hybrid.ts`)
   already sanitizes free text into a phrase-OR MATCH query.
2. **Messages are persisted clean:** `stripThinkBlocks` runs before persist AND before
   history replay (Phase 20 D6) — a message FTS index can never index reasoning text.
   Schema: `messages(id, conversation_id, role, content, created_at, token_count,
   citations_json)`; `deleteConversation` deletes messages explicitly (no CASCADE).
3. **The vault key is derived DIRECTLY from the password.** `VaultDescriptor`
   (`services/workspace-vault.ts`) = `{ version, mode, kdf, saltB64, verifier }` — there is
   **no wrapped data key**. The DB file (`paid.sqlite.enc`) and every per-document file
   (`<id><ext>.enc` via `DocumentCipher`) are encrypted under the password-derived key
   itself. ⇒ a naive password change must re-encrypt the DB **and every document sidecar**;
   an envelope-key migration changes the on-disk descriptor format (→ D24, the load-bearing
   decision of Phase 32). `deriveKey` already dispatches on `kdf.algo` (argon2id/scrypt) and
   the descriptor has a `version` field — the v2 migration hook exists.
4. **Parsers are a clean plug-in interface, main-process only:**
   `DocumentParser { name, extensions, mimeType, parse(filePath) → ParsedDocument }` with
   `ExtractedSegment { text, pageNumber?, sectionLabel? }` (`services/ingestion/parsers/`).
   Chunking packs same-label segments, windows at ~500 tokens/80 overlap; **page-less chunks
   are deduped by chunk id, not collapsed** (the txt/md rule) — timestamped audio segments
   ride this path safely. `Citation` already carries `section` → timestamp labels surface in
   citations with zero citation-path changes.
5. **The sidecar pattern is fully reusable:** `LlamaServer` (spawn → free loopback port →
   `/health` poll → fetch) is composed three times already (chat, E5 `--embedding
   --device none`, reranker `--rerank --device none` with lazy start, will-quit stop,
   lock-time `suspend()`). `runtime-sources.yaml` + `validateRuntimeSources` +
   `.paid-runtime.json` markers + `fetch-runtime.{ps1,sh}` + `assertCommercialDrive`
   runtime checks form the complete distribution pipeline a second sidecar family plugs
   into. Manifest `role:` + `download` block means **the Phase-18 in-app downloader covers
   new model weights with zero new code** (D14 precedent).
6. **Ingestion jobs are async-with-polling** (`importDocuments → { jobId }`,
   `getImportJob` 400 ms poll; per-file truth in the documents table). Encrypted workspaces
   already decrypt stored documents to a transient `.parse<ext>` for re-index and shred it
   after — the transcriber/OCR temp-file pattern exists.
7. **Additive column migrations have a precedent** (`conversations.scope_json` via guarded
   `ensureColumn`) — summary/translation metadata columns follow it.
8. **Generation concurrency is per-conversation:** the in-flight registry is
   `Map<conversationId, AbortController>` shared by chat + RAG. Document tasks (summary/
   translation/compare) are NOT conversations — they need their own abort + busy semantics
   (→ D26, resolved: strict one-at-a-time). The llama-server slot count (default
   parallelism) gets an informational probe (R-T1).
9. **`updateSettings` whitelists keys against `DEFAULT_SETTINGS`** — every new settings key
   is an explicit, validated addition.
10. **Renderer media capture is available:** Electron's renderer has `getUserMedia`/
    WebAudio; the main process has **no DOM/canvas** (pdfjs runs there in text-extraction
    mode only). Anything that must *render* a PDF page or decode/resample audio in JS
    belongs in a renderer-side context (→ D30, D31).

## 3. Ordering rationale & dependency graph

```
31 search ──────────────────────────────┐ (independent, smallest, proven tech)
32 password change ─────────────────────┤ (independent; one crypto decision D24)
33 document tasks + summary ──┬─────────┤
                              ├→ 34 translation
                              └→ 35 compare
36 whisper distribution + transcription ──→ 37 dictation
38 OCR (independent; research-gated; detection-only step can ship any time)
```

- **31 first:** smallest feature, highest utility-per-effort, zero research gates, and it
  exercises the exact FTS5 pattern (migration + triggers + backfill) Phase 21 locked —
  a warm-up that hardens a second instance of a known-good design.
- **32 second:** small surface but security-critical; D24 (envelope vs re-encrypt) got its
  own review before code (resolved round 1, §13), like the Phase-22 key-management
  precedent. No other phase depends on it; do it early because vault code changes want
  maximal soak time before a release.
- **33 before 34/35:** summary, translation, and compare are all "run the local model over
  stored chunks, persist/export a result" — one **document-task service** (job state machine
  on the import/download polling precedent, model-busy semantics, cancel) is built ONCE in
  Phase 33 with summary as its first client. 34 and 35 are then mostly prompt templates +
  output handling + UI.
- **36 before 37:** dictation is a thin client of the transcription sidecar; transcription-
  as-ingestion is the feature that justifies the whole whisper distribution pipeline.
- **38 last (or parallel):** OCR shares nothing with 31–37; its research gates (offline
  asset vendoring, where rendering happens) carry real descope risk, so resolve them before
  committing. Its step 0 (image-only-PDF **detection + friendly notice**, no OCR) is a
  small trust fix in the Phase-17 spirit and may be pulled forward into any earlier phase.

---

## 4. Phase 31 — Conversation search — ✅ DONE (2026-06-11, as implemented)

Shipped exactly per the sketch; durable design now in `architecture.md` (Chat § "Conversation
search"), `security-model.md` (permission handler), `user-guide.md` §6. Record of what was built:

- `messages_fts = fts5(content, message_id UNINDEXED)` — self-contained, three sync triggers,
  guarded migration + one-time backfill (`ensureMessagesFts` in `db.ts`, the `ensureChunksFts`
  shape verbatim). R-S1 resolved GO (§14): `snippet()`/`highlight()` work in both runtimes —
  the JS-truncation fallback was never needed.
- `buildFtsMatchQuery` **lifted to `services/fts.ts`** (shared module); `rag/hybrid.ts`
  re-exports it so Phase-21 import sites are unchanged (a test asserts same-function identity).
- `searchMessages(db, query, limit=40)` in `services/chat.ts`: bm25 ranking, newest-first
  tie-break (`ORDER BY bm25, created_at DESC, rowid DESC` — D23), hits grouped per
  conversation in best-hit order; snippets via `snippet()` with `U+0001`/`U+0002`
  (`SEARCH_MARK_*`) highlight markers the renderer splits on (no HTML parsing).
- IPC `chat:search` + preload `searchConversations` (request/response; handler never logs
  the query). UI: search input atop `ConversationList.tsx`, debounced 150 ms, results swap
  the grouped list, Esc/clear restores it; message-level scroll-to was skipped as allowed.
- Privacy held: **no audit event, nothing logged** — sentinel test asserts `runtime_events`
  stays empty across an IPC search.
- **Session-hardening rider shipped (§12):** deny-by-default
  `session.setPermissionRequestHandler` (`services/permissions.ts`) installed next to the CSP
  in `main/index.ts`, no exceptions (Phase 37 adds scoped `media`); verified live
  (Notification → `denied`, getUserMedia → `NotAllowedError`) and `npm run dev` unaffected.
- Tests: migration/backfill on a pre-Phase-31 fixture, trigger sync incl. conversation
  delete, sanitizer reuse + operator-injection, ranking/tie-break determinism, grouping,
  limit, IPC + privacy sentinel, permission handler (fake session), renderer search flow
  (type → highlighted results → open → clear, no-match copy, Esc).

## 5. Phase 32 — Vault password change — ✅ DONE (2026-06-11, as implemented)

Shipped exactly per D24 (b): **descriptor v2 envelope, migrate-on-first-password-change**.
Durable design now in `security-model.md` ("Vault descriptor" + "Password change"),
`user-guide.md` §10, `known-limitations.md` (version-skew + post-commit-swap edges).
Record of what was built:

- **Descriptor v2 (envelope)** in `workspace-vault.ts`: a random 32-byte data key
  (`generateDataKey`, `crypto.ts`) encrypts the DB + every `<id><ext>.enc` sidecar; the
  password-derived KEK wraps it (`dataKey` AES-256-GCM blob next to the verifier). **New
  vaults are created v2** (their first change is already O(1)); v1 unlocks unchanged via the
  existing `version` + `deriveKey` dispatch hooks and migrates ONLY on its first password
  change — never on unlock. Unlock unwraps the data key and zeroes the KEK.
- **`WorkspaceController.changePassword(current, next)`** (IPC `workspace:changePassword` +
  preload mirror, `unlockWorkspace` result shape): unlocked only; verifies `current` against
  the existing verifier FIRST (wrong → `WrongPasswordError`, audited as the existing
  `workspace_unlock_failed` class); replaces the in-memory key in place (no re-lock). v2 →
  `rewrapVaultKey`: one atomic descriptor replace (fresh salt + verifier + re-wrap under
  `DEFAULT_KDF` — a legacy scrypt vault thereby silently upgrades to argon2id). v1 → the
  one-time journaled migration composed from existing primitives: `stageRekey` (WAL
  checkpoint, re-encrypt DB + sidecars to fsynced `.new` files; per-doc plaintext transients
  end `.tmp` for the startup sweep) → descriptor replace = the single COMMIT point →
  `applyPendingRekey` (shred old, rename `.new` in). `recoverPendingRekey` (startup + before
  every unlock decrypt) rolls staged files forward on a v2 descriptor, discards them on v1 —
  crash tests cut the journal at every step and prove old-or-new, never mixed. In-memory key
  swaps immediately after commit so a post-commit swap failure can't desync lock().
- **Race guard:** `beginDocumentWork()` lease on the controller — `importDocuments` (whole
  job) + `reindexDocument` hold it; `changePassword` refuses while held and vice versa
  (`VaultBusyError`, friendly §11.4 copy both ways).
- **Audit:** additive `workspace_password_changed`, success-only, id- and content-free.
- **UI:** Settings → General "Change password" card (current/new/confirm); the Phase-27
  strength meter + show-toggle EXTRACTED from `WorkspaceGate` into
  `renderer/components/PasswordField.tsx` and reused by both; honest busy copy ("Securing
  your documents with the new password…"); hidden entirely in plaintext_dev.
- Tests (`tests/integration/password-change.test.ts` + audit-ipc + renderer
  `ChangePassword.test.tsx`): change-then-unlock-with-new on scrypt AND argon2id legacy
  fixtures (`createEncryptedVaultOnDisk(…, { legacyV1: true })` exists for fixtures only);
  old password rejected; wrong current rejected + audited in the unlock-failure class;
  crash cuts at stage/commit/swap each recover consistent with documents decryptable;
  second change asserted O(1) (sidecar + DB `.enc` byte-identical); the descriptor/`.enc`
  scan extended to the wrapped blob (no password, no raw/base64/hex data-key bytes);
  plaintext_dev hides the card. Eyeballed in the built app (walk-phase32.mjs): create →
  import → wrong-current error → change → lock → old password rejected → unlock with new →
  document still previews.

## 6. Phase 33 — Document tasks foundation + one-click summary — ✅ DONE (2026-06-11, as implemented)

Shipped exactly per the sketch (D25 + D26 as resolved). Durable design now in
`architecture.md` (§ "Document tasks"), `user-guide.md` §7 ("Summarize a document"),
`known-limitations.md` ("Document tasks & summaries"). Record of what was built:

- **`services/doctasks.ts` — `DocTaskManager`**, the shared engine for Phases 34–35:
  `startDocTask({ kind, documentIds, params }) → { jobId }` / `getDocTask(jobId)` (state,
  `progress { stepsDone, stepsTotal }`, friendly `error`, `resultRef`) /
  `cancelDocTask(jobId?)` — **no jobId = cancel the active task** (the chat banner's
  affordance). FIFO queue, one runner, per-task `AbortController` (never an entry in the
  per-conversation in-flight map — fact §2.8); unknown job ids report terminal so pollers
  stop. Kinds `translation`/`compare` are accepted by the shapes but refuse friendly until
  34/35. Deps injected (`getDb/getRuntime/isChatStreaming/getContextTokens/audit`);
  exposed as optional `AppContext.docTasks`.
- **D26 enforced both ways:** `startDocTask` refuses while a chat streams; `chat:send` +
  `rag:ask` throw the shared `DOC_TASK_BUSY_MESSAGE` (`shared/types.ts`) while a task is
  active, which the chat screen renders with a working "Cancel document task" button.
  Tasks call the active runtime via `chatStream` with explicit `maxTokens`/`temperature`
  (temp 0.3, no depth modes); no runtime → friendly refusal, never an auto-start. A
  cancelled task persists nothing (chat keeps partials; tasks do not).
- **Summary algorithm (D25) with provable-fit budgets:** input = stored chunks in order
  (no re-parse; the ~80-token overlap repetition accepted). Per-call input budget derived
  in WORDS: `(max(1024, contextTokens) − 512 output − 300 prompt reserve) / 1.3`
  words→tokens safety factor (the chunker's whitespace estimate undercounts real tokens —
  this is the "verify against real chunk rows" answer: budget-sized windows cannot
  overflow the real context). Single window → one call; else greedy packing (over-budget
  chunks are SPLIT, not truncated) → map calls with `maxTokens = usableTokens/windows`
  (so all partials provably fit the reduce input, plus a hard word-truncate belt) → one
  reduce. Ceiling `SUMMARY_MAP_CALL_CEILING = 12` → `truncated` flag, honest UI copy.
  Think blocks stripped from outputs (D6 defense-in-depth).
- **Persistence:** `documents.summary_json` (`ensureColumn`) holding
  `{ text, modelId, createdAt, truncated }`, surfaced as `DocumentInfo.summary`; cleared
  FIRST by `reindexDocument`, gone with delete; malformed JSON reads as null. **No
  `beginDocumentWork()` lease, deliberately** (reads chunks + writes one column, never
  `.enc` sidecars — stated in the code); instead `registerDocsIpc` refuses
  re-index/delete of a task-busy document (`isDocumentBusy`).
- **IPC/UI:** `doctasks:start/get/cancel` + preload mirrors; module-level renderer watcher
  (`renderer/lib/doctasks.ts`, `useSyncExternalStore`) so busy/progress survives
  navigation; row "Summarize"/"Summarize again" with "Summarizing… (n/m)" + Cancel; on
  completion the preview opens with the summary as a collapsible section ("Generated by
  <model> · <date>", truncation banner, Regenerate). New `renderer/lib/errors.ts`
  `friendlyIpcError` strips Electron's "Error invoking remote method…" prefix in the
  Chat/Documents banners (§11.4). Audit: additive `document_task_completed/_failed`,
  `{ kind, documentId }` only — sentinel-tested end-to-end (a sentinel seeded through a
  real summarized document never reaches `runtime_events`).
- Tests: `unit/doctasks-windows.test.ts` (budget boundaries, cutover, ceiling, split-not-
  truncate, reduce-fit), `integration/doctasks.test.ts` (17: e2e single-pass/map-reduce/
  ceiling, queue serialization with max-concurrency proof, both cancel paths, runtime
  absent at start AND at dequeue, friendly failure + ids-only audit, persistence
  lifecycle), `integration/doctasks-ipc.test.ts` (handlers + both D26 guards + busy-doc
  guard), `audit-ipc.test.ts` extension, `renderer/DocumentSummary.test.tsx` (8: flow,
  busy/cancel, failure copy, regenerate, truncation note, chat busy banner). Eyeballed in
  the built app (walk-phase33.mjs): import → mock runtime → Summarize → progress → summary
  in preview (both themes) → persists across navigation → chat busy copy + cancel →
  re-index clears → regenerate.

## 7. Phase 34 — Document translation workflow — ✅ DONE (2026-06-11, as implemented)

Shipped per D27 (materialized corpus document) with the new input decision **D36** (see
§13) and the R-T2 translation findings (§14) folded into the window math. Durable design
now in `architecture.md` (§ "Document tasks" — translation, D36, the lease split),
`user-guide.md` §7 ("Translate a document"), `known-limitations.md` ("Document
translation"). Record of what was built:

- **A `translation` kind on the Phase-33 engine** (`services/doctasks.ts`): the kind guard
  fell away (only `compare` still refuses); validation = `params.targetLang: 'de' | 'en'`
  (closed v1 set — a free-text language field invites silent quality failures) + exactly
  one source document, indexed with chunks. Queue/cancel/polling/both D26 guards came free
  from Phase 33 — nothing was duplicated. New injected deps for materializing kinds:
  `getStoreDir` / `getIngestionDeps` / `beginDocumentWork`.
- **D36 (input): re-extracted parser SEGMENTS, not stored chunks.** Chunks overlap by ~80
  tokens; in-order chunk concatenation would duplicate text at every boundary (a summary
  tolerated it, a faithful translation cannot). `extractDocumentPreview` is the existing
  ordered, non-overlapping re-extraction (encrypted copies decrypt to a `.parse*`
  transient, shredded inside); overlap-trimming chunks was rejected as heuristic where the
  re-parse is exact. Cost: one re-parse — the same the in-app preview pays.
- **Window math from MEASURED token weight (R-T2):** the usable context (ctx − 300 reserve)
  splits input 1.3 tokens/word vs output **2.0 tokens/word**
  (`TRANSLATION_OUTPUT_TOKENS_PER_WORD` — the smoke's first run TRUNCATED a near-budget
  German output under a half/half split; see §14). At 4096 ctx: 1150-word windows,
  `maxTokens` 2301. Segments pack greedily in order (over-budget segments split, never
  truncated); **no window ceiling, no reduce** — a faithful translation may not silently
  truncate; long documents just take more windows (visible progress, cancel anytime).
- **Strict template, temp 0.2** (R-T2-validated: zero refusal/chatter, full Markdown
  survival, no language drift, embedded instructions translated not obeyed): translate
  faithfully/completely, preserve Markdown, numbers/names/dates verbatim, output only the
  translation. **Retry-then-mark policy:** a failed/empty window is retried once, then
  marked visibly in the output (`failedWindowNotice`, §11.4 copy) with the ORIGINAL text
  kept below — never dropped; all-windows-failed fails the task.
- **Materialize (D27) under the Phase-32 lease:** only after all windows (cancel persists
  nothing): attribution line ("Machine-translated by <model> — may contain errors.") +
  body → a `<jobId>.parse.md` transient (crash-sweep-covered, shredded in `finally`) →
  the NORMAL import path (`createQueuedDocument` with display title
  "<original> (Deutsch|English).md" + `processDocument` with real ingestion deps) ⇒
  chunked, embedded, searchable, citable, `.enc` automatically. `beginDocumentWork()` is
  held around exactly this step (never the long window loop); `VaultBusyError` passes
  through as a friendly failure. A failed import deletes the half-born row. Provenance =
  additive `documents.origin_json` (`ensureColumn`) `{ translatedFrom, targetLang }`,
  surfaced as `DocumentInfo.origin` (malformed → null; survives re-index — provenance,
  not sync; staleness recorded in `known-limitations.md`). The output document id is
  appended to the task's `documentIds` at creation so `isDocumentBusy` covers it.
- **Audit:** `document_task_completed/_failed` with `{ kind: 'translation', documentId }`
  (the SOURCE; output id travels in `resultRef`) + a `document_imported` for the
  materialized document (filename + id only) + new additive `document_exported`
  (id only). Sentinel-tested end-to-end through a real translated + exported document.
- **UI/IPC:** row "Translate" → target-choice modal (German/English) → "Translating…
  (n/m)" + Cancel via the generalized module-level watcher (`startTask(kind, id, params)`
  — one store, no second one); completion reveals the new document with a quiet
  "Translated from <original>" line (row + preview). New `docs:export` channel
  (the `exportConversation` pattern: save dialog in main, ids-only audit) saves a text
  document's stored Markdown — shown on materialized rows.
- **Tests:** `unit/doctasks-windows.test.ts` (budget split, packing/order/split, NO
  ceiling, fit property, templates incl. verbatim-numbers, notice/attribution/title) ·
  `integration/doctasks-translation.test.ts` (12: validation, the D36 overlap regression
  — 600 unique words, every word exactly once in output, order proven — retry-then-mark,
  all-fail, cancel-persists-nothing, lease acquired after the last window + released,
  VaultBusyError friendly, busy-guard on the output doc via a gated embedder, encrypted
  e2e with only-`.enc`-on-disk + export, origin re-index survival + malformed JSON) ·
  audit-ipc sentinel extension (translate + export a sentinel document over real IPC) ·
  `renderer/DocumentTranslate.test.tsx` (7: target choice, en variant, busy/cancel,
  friendly failure, provenance row+preview, export, deleted-source fallback). Gate:
  typecheck clean, 828/828 + manual skips, build green. Eyeballed against the built
  bundle (walk-phase34.mjs, shots-p34): import → mock runtime → Translate→German →
  progress → "(Deutsch)" doc indexed with attribution + provenance → preview → ask in
  chat (Sources disclosure) → cancel leaves no output → Export writes a real file.

## 8. Phase 35 — Compare two documents — ✅ DONE (2026-06-11, as implemented)

Shipped per D28 (materialized "Comparison: A vs B" document, auto mode-switch by token
math) with the new input decision **D37** (see §13) and the R-T2 comparison findings
(§14, both rounds) setting the shipped templates. Durable design now in
`architecture.md` (§ "Document tasks" — compare), `user-guide.md` §7 ("Compare two
documents"), `known-limitations.md` ("Document comparison"). Record of what was built:

- **A `compare` kind on the Phase-33 engine** (`services/doctasks.ts`): the last kind
  guard fell away; validation = exactly TWO distinct source documents, both indexed
  with chunks (`TASK_COMPARE_PICK_TWO_MESSAGE`). Queue/cancel/polling/both D26 guards
  and `isDocumentBusy` (covering BOTH sources + the output document) came free from
  Phase 33 — nothing was duplicated.
- **Auto mode-switch by token math (D28):** the per-call input budget is the D25 shape
  — `(max(1024, ctx) − 512 output − 300 prompt reserve) / 1.3` words. Both re-extracted
  full texts fit ⇒ **mode (a)**: ONE structured-comparison call over both. Else
  **mode (b)**: doc A's chunks pack into half-budget windows (over-budget chunks split,
  pieces keep their chunk id); for each window the nearest doc-B chunks come from the
  EXISTING `VectorIndex` scoped to doc B with the active embedder's id (stored vectors
  only — deterministic, no re-embedding, no new index; top-3 neighbors per A-chunk,
  best-first fill of the other half-budget, presented in doc-B order); per-pair map
  calls use a SMALLER prefixed-bullets format (R-T2-confirmed necessary), then one
  reduce builds the four-section report. Map ceiling 12 (the D25 rationale) → honest
  `compareTruncationNotice` IN the report ("covers the beginning of A"); map output
  caps sized so all notes provably fit the reduce input.
- **D37 (mode-(a) input + the mode decision): re-extracted parser SEGMENTS** — chunk
  overlap would read as phantom "shared" content and inflates a chunk-based length
  estimate by ~16% (enough to mis-route the mode switch). Mode (b)'s map uses stored
  CHUNKS (vectors needed; notes tolerate overlap — D25 precedent).
- **Embedder-visibility guard (the §8 audit finding):** before any model call, mode (b)
  verifies BOTH documents have vectors under the ACTIVE embedder id; a stale (or
  vectorless) document fails friendly with the Phase-17-style actionable
  `TASK_COMPARE_REINDEX_MESSAGE` — never a silently empty pairing. Mode (a) needs no
  vectors and deliberately skips the guard.
- **Templates (R-T2, two smoke rounds on the real b9585 + Qwen3-4B):** the four
  dictated sections (share / differ / only-in-A / only-in-B), temp 0.3, output cap 512.
  Round 2 added the exactly-ONE-section instruction (reduce placement) and the
  "check every fact in the section of A" recall instruction (fixed a silent per-pair
  omission). Headings are dictated verbatim (deterministic structure); the body follows
  the documents' language.
- **Materialize (D27 path, unchanged):** attribution line ("Machine-generated
  comparison by <model> — may contain errors.") + optional truncation notice + report →
  `<jobId>.parse.md` transient → the normal import path under the Phase-32 lease (held
  around exactly that step) ⇒ "Comparison: <A> vs <B>.md", chunked/embedded/searchable/
  exportable/`.enc`. Provenance: `DocumentOrigin` became a discriminated union
  (additively — Phase-34 rows without `type` parse as `'translation'`); compare rows
  persist `{ type: 'compare', comparedFrom: [a, b] }`, surfaced via
  `DocumentInfo.origin`. Cancel persists nothing; a failed import deletes the half-born
  row.
- **Audit:** `document_task_completed/_failed` carry `{ kind: 'compare', documentId,
  documentIdB }` (ids only, additive) + `document_imported` for the report; the
  audit-ipc sentinel test was extended end-to-end (two sentinel documents compared over
  real IPC; the report carries both sentinels, `runtime_events` never does).
- **UI:** the Phase-17 multi-select checkboxes gained "Compare (2)" (visible at exactly
  two selections); the module-level watcher generalized to `documentIds` so BOTH source
  rows show "Comparing… (n/m)" + Cancel; completion opens the new report's preview with
  the "Comparison of <A> and <B>" provenance line (row + preview); Export works on it
  (any materialized document).
- **Tests:** `unit/doctasks-windows.test.ts` (compare budget/mode boundary, window
  packing/split-keeps-id/ceiling, reduce-fit property, all templates) ·
  `integration/doctasks-compare.test.ts` (10: two-distinct validation, mode-(a) e2e
  with the D37 exactly-once regression + provenance + ids-only audit, no-vectors
  mode (a), the mode-switch boundary, mode-(b) pairing shape + DETERMINISM (two runs,
  byte-identical prompts), ceiling + truncation notice, the staleEmbeddings guard
  (both variants, failing BEFORE any model call), cancel-persists-nothing, lease
  after-the-calls/released) · `doctasks-ipc.test.ts` (compare e2e over real IPC
  handlers, both-rows busy guard, two-distinct friendly refusal) · audit-ipc sentinel
  extension · `renderer/DocumentCompare.test.tsx` (6: exactly-two gating, busy on both
  rows + cancel, completion + auto-open + provenance, friendly failure, export,
  deleted-source fallback). Gate: typecheck clean, 860/860 + manual skips, build green.
  Eyeballed against the built bundle (walk-phase35.mjs, shots-p35): import two docs →
  mock runtime → select two → Compare (2) → progress → report preview with provenance →
  report row with Export.

## 9. Phase 36 — Audio transcription as document ingestion (whisper.cpp) — ✅ DONE (2026-06-11, as implemented)

Shipped per the sketch with **D34 + D35 resolved** (see §13) and all four research gates
run FIRST on the real pinned binary + real German audio (§14). Durable design now in
`architecture.md` (§ "Audio transcription" + the second-family notes in § "Drive tooling"),
`drive-layout.md` (whisper family + source-build story), `model-policy.md` (whisper
licenses), `user-guide.md` §7 ("Import an audio recording"), `known-limitations.md`
("Audio transcription"), `PRIVACY.md` (no audio upload). Record of what was built:

- **Distribution (mirrors Phases 12/14):** additive top-level `whisper_cpp:` block in
  `runtime-sources.yaml` (pin **v1.8.6**, real hash from a fresh download);
  `validateRuntimeSources` grew a per-family validator returning the optional `whisper`
  result (older-app-ignores-it property regression-tested; duplicate triples rejected
  PER family — the same triple may exist in both). `fetch-runtime.{ps1,sh}` gained
  `--family llama_cpp|whisper_cpp` + **block-aware yaml parsing** (the flat parsers would
  have leaked whisper builds into llama selections), family-specific binary names, and
  the same marker/verify logic. `drive.ts` layout + `prepare-drive` add
  `models/transcriber/` + `runtime/whisper.cpp/<os>/`; `assertCommercialDrive` takes an
  optional `whisperSources` pin (same binary+marker gate, binary `whisper-cli`);
  `build-commercial-drive.{ps1,sh}` fetch the whisper family and cross-check its marker
  natively (per-family version parsing). **Win prebuilt only** (R-W1) — mac/linux are a
  documented source-build step; a drive without the binary degrades to the friendly
  per-file failure. CPU-only by design.
- **Weights:** `model-manifests/transcriber/whisper-small-multilingual.yaml`
  (`role: transcriber` — additive `ModelRole`; format `ggml`, runtime `whisper_cpp`,
  real sha256 + download block, MIT license review approved, bundled by default, all
  profiles). The Phase-18 downloader + `fetch-models` + `verify-models` cover it with
  zero new code (verified in the walk: the AI Model screen lists it with the
  "Turns audio recordings into searchable text" hint).
- **`services/transcriber/`:** `Transcriber` interface +
  `createSelectedTranscriber` (real iff binary+weights else **null**, no mock — D9);
  `WhisperCliTranscriber` spawns the CLI per file (D34) with `-oj` JSON to a
  `.parse-transcript.json` transient in the documents dir (content → shredded in
  `finally`, crash-sweep-covered via the `.parse` infix; never written next to the
  user's original). **Success = the JSON parses, never the exit code** (R-W2's exit-0
  decode-failure mode maps to a distinguishable decode error); the error tail keeps
  **stderr only** (stdout carries the transcript — content must never ride an error
  into logs); `-pp` progress parsed to an `onProgress(0–100)`; `suspend()`/`stop()`
  kill in-flight children (lock/will-quit wired in `registerWorkspaceIpc`/`main`).
  `PAID_WHISPER_BIN` dev override, `resolveWhisperCliPath` mirrors the llama resolver.
- **`AudioParser`** (`.wav/.mp3/.flac/.ogg` — R-W2's verified list; m4a descoped):
  transcriber arrives per call via the ADDITIVE `ParseContext` second parameter on
  `DocumentParser.parse` (from `IngestionDeps.transcriber` — the embedder precedent).
  Whisper segments are **packed** (~180-word target, hard cap 400) into time-labeled
  `ExtractedSegment{ sectionLabel: "mm:ss–mm:ss" }` (D29 — `h:mm:ss` above an hour):
  packing prevents thousands of tiny chunks (distinct labels never coalesce) AND makes
  every audio chunk exactly one packed segment verbatim — so
  `extractDocumentPreview` reads audio text from STORED CHUNKS (instant preview;
  translate/compare re-extraction without re-transcription). Absent transcriber ⇒ the
  file fails friendly with the download-the-model copy; decode failure ⇒ convert-to
  copy; anything else ⇒ honest retry copy + the technical reason in the local log.
- **D35 resolved (keep the copy):** stored audio rests `.enc` on encrypted workspaces
  (e2e-tested: only-`.enc`-on-disk; re-index decrypts to `.parse<ext>`, hands THAT to
  the CLI, shreds it); re-index = full re-transcription (known-limitations); imports
  >50 MB picked audio confirm first (`docs:importPreflight` → `summarizeImportPaths`);
  "Transcribing… N%" progress on import AND re-index via an in-memory map merged into
  `listDocuments` (`DocumentInfo.transcriptionProgress` — no new channel). No
  transcript cache (only on evidence).
- **UI:** the Supported line advertises the four verified formats ("…which are
  transcribed on this drive"); the picker filters get them via `supportedExtensions()`;
  the extracting badge reads "Transcribing… N%" for audio (text keeps "Reading");
  large-audio ConfirmDialog with honest copy. No new settings keys.
- **Audit:** `document_imported` covers audio (filename + id only); the audit-ipc
  sentinel test gained an audio leg (a fake-transcriber transcript sentinel flows into
  chunks/preview but never `runtime_events`).
- **Tests (51 new; 910/910 green):** `unit/audio-parser.test.ts` (packing/labels/
  1:1-chunk invariant/friendly failures), `unit/transcriber.test.ts` (selector matrix,
  fake-spawn CLI: JSON parse, progress, exit-0 decode mode, hard exits, suspend/stop,
  transient shred), `integration/audio-ingestion.test.ts` (e2e with fake transcriber:
  D29 labels, absent-transcriber per-file failure, preview-from-chunks with
  no-second-transcription proof, re-index = re-transcription, encrypted
  only-`.enc`-on-disk, preflight), runtime-sources second-family + forward-compat +
  per-family duplicates, assets whisper marker logic, commercial whisper gate,
  renderer formats-line/badge/confirm tests, audit sentinel audio leg. Manual harness
  `tests/manual/whisper-smoke.test.ts` (`PAID_WHISPER_SMOKE` + `PAID_WHISPER_AUDIO`,
  never-committed local audio): per-format decode legs, m4a expected-fail leg, long-file
  leg. Eyeballed in the BUILT app (walk-phase36.mjs, shots-p36, real binary + weights
  on a temp root): import german wav → real whisper run → Ready/audio-wav/Sections 1 →
  Preview shows the transcript under its "00:00–00:38" label; absent-transcriber root →
  the exact friendly failure banner. Gate: typecheck clean, 910/910 + manual skips,
  build green.

## 10. Phase 37 — Voice dictation into the chat composer — ✅ DONE (2026-06-11, as implemented)

Shipped exactly per the locked D30 pipeline (renderer bytes → main transient → Phase-36
transcriber), as a thin client of Phase 36. Durable design now in `architecture.md`
(§ "Voice dictation"), `security-model.md` (the scoped-permission section + the
dictation data-path section), `user-guide.md` §6 ("Dictate a message"),
`known-limitations.md` ("Voice dictation"), `PRIVACY.md` (microphone bullet). Record of
what was built:

- **Renderer capture (D30, zero new deps):** `renderer/lib/dictation.ts` — `getUserMedia`
  audio → `MediaRecorder` (webm/opus) → decode + resample/downmix to **16 kHz mono** in
  ONE `OfflineAudioContext` render → `renderer/lib/wav.ts` `encodeWavPcm16` (pure JS,
  hand-written RIFF header, unit round-tripped incl. clamping). Streaming ASR stayed out
  of scope.
- **IPC `dictation:transcribe`** (+ preload `transcribeDictation`; request/response, no
  new event channels): `ipc/registerDictationIpc.ts` writes the bytes to
  `<uuid>.parse-dictation.wav` in the documents dir (the `.parse` infix ⇒ the startup
  `shredStalePlaintext` crash sweep covers a crash mid-dictation), runs
  `Transcriber.transcribe(tempPath, { workDir: documentsDir })` (the CLI's own transcript
  JSON transient lands in the same swept dir), returns whitespace-normalized joined text,
  **shreds the WAV in `finally`**. Guards: absent transcriber → friendly refusal
  (backstop — the UI is hidden anyway); empty/non-byte payload rejected before disk;
  64 MB cap (≈35 min of 16 kHz PCM16) with "import the audio file instead" copy. Failures
  return the fixed friendly copy ("Could not transcribe that — try again."); the technical
  reason goes to the local log only (stderr-only tails, the Phase-36 guarantee). **No
  audit event** (content-adjacent, plan §12).
- **Permissions (the §12 audit item, closed):** `services/permissions.ts` became
  `installPermissionRequestHandler(session, { allowMicrophoneFor })` — still
  deny-by-default; grants ONLY `media` requests that are **audio-only** (`mediaTypes`
  present and all `'audio'`; absent/empty = unverifiable = denied) **and** from the app's
  own WebContents (reference-compared). The unit test drives the full scope matrix
  (other requester / video / audio+video / no details / every other permission) so the
  allow cannot silently widen. `details` is typed `unknown` in the structural session
  slice (Electron's non-media `details` union members share no properties with the media
  shape — a narrower type fails assignability against the real `Session`).
- **Availability gating (D14 precedent, no settings key):** additive
  `AppStatus.dictationAvailable` (= `ctx.transcriber != null`); ChatScreen reads it
  best-effort and the mic simply doesn't render without it.
- **Composer UI:** `renderer/chat/DictationButton.tsx` (ghost mic beside Send;
  click-to-start / click-to-stop with `aria-pressed`, pulse while recording —
  `prefers-reduced-motion` respected; spinner while transcribing; disabled while an
  answer streams; unmount mid-recording cancels + releases the mic). The OS mic
  indicator is the recording signal. Insert-at-cursor lives in `Composer.tsx`: prefers
  `document.execCommand('insertText')` so the insert joins the textarea's native undo
  stack and React's onChange fires naturally; falls back to a value splice + caret
  restore (the jsdom test path). Space-padding against neighbours; **never auto-sends**.
  Failures surface through the screen's existing error Banner (`onDictationError`);
  empty transcription gets its own no-speech notice. Capture is injectable
  (`dictationCaptureImpl`) for renderer tests — the spawnImpl precedent.
- **Tests (+21 net; 931/931 green):** `unit/wav.test.ts` (header/round-trip/clamp/empty),
  `unit/permissions.test.ts` (scope matrix), `integration/dictation-ipc.test.ts`
  (temp-file naming + dir + bytes fidelity, workDir steering, shred on success AND error,
  friendly absent/empty/oversize refusals, raw CLI error never crosses IPC, no audit,
  Buffer payload), `renderer/Dictation.test.tsx` (ChatScreen gating both ways, record →
  insert-at-caret with spacing + caret restore, never-send, no-speech notice, IPC-prefix
  stripping, mic-blocked recovery, unmount releases mic). Manual harness
  `tests/manual/dictation-smoke.test.ts` (`PAID_DICTATION_SMOKE` + `PAID_WHISPER_AUDIO`)
  drives the REAL whisper-cli through the real IPC handler with real German WAV bytes —
  a real microphone is not headlessly drivable; the renderer half needs a human in the
  built app.

## 11. Phase 38 — Scanned-PDF / photo OCR — ✅ DONE (2026-06-11, as implemented)

Image-only PDFs and photos (`.png`/`.jpg`/`.jpeg`) become searchable corpus documents
via local OCR (tesseract.js 7.0.0, WASM, pinned exact; German + English). All three
research gates ran FIRST on real artifacts (the Phase-36 discipline) — findings in §14;
D31/D32 resolved from them (§13). The full mechanism doc is `architecture.md`
("Scanned-PDF / photo OCR"); licenses in `model-policy.md`; the asset class in
`drive-layout.md`; honest costs in `known-limitations.md`.

- **Step 0 — detection (shipped first, the Phase-17 trust fix):** a PDF where no page
  reaches 25 extractable chars fails friendly ("This PDF looks like a scan — it has no
  readable text yet.") instead of silently indexing nothing. `DocumentInfo.scanDetected`
  is DERIVED (failed + the exact notice — no schema change). Hybrid text+scan PDFs are
  NOT detected (their text pages index normally). Fixtures are synthesized in
  `tests/helpers/fixtures.ts` (`makeScanOnlyPdf`/`makeHybridPdf` — a real 1.1 kB JPEG
  in handcrafted PDFs; zero binary fixtures committed).
- **D31 as built — the split design:** a hidden BrowserWindow (`ocr.html` + its own
  five-channel sandboxed preload; pull-based `OCR_RASTER` protocol with recognition
  backpressure) does ONLY pdf→PNG rasterization at 300 DPI (cap 4096 px/side) with the
  SAME pinned pdfjs LEGACY build the PdfParser uses — the modern v6 build calls
  `Uint8Array.prototype.toHex`, which Electron 37's Chromium lacks (found live in the
  eyeball walk; the probe had used legacy). Recognition always runs MAIN-side in
  tesseract.js Node mode on Buffers (`services/ocr/`: engine + factory + rasterizer).
  Two implementation traps recorded: a SANDBOXED preload must be a single file (the
  multi-entry preload build splits shared chunks → the ocr preload hardcodes its
  channel literals, contract-tested), and bytes crossing the contextBridge are
  cross-realm typed arrays pdf.js rejects (copied into a same-realm array first).
- **D33 as built:** "Make searchable (OCR)" = doc-task kind `'ocr'` on the Phase-33
  engine (queue/progress/cancel; needs the OCR engine, NOT the chat runtime; the D26
  chat-streaming guard holds). Recognition persists in the additive
  `documents.ocr_json` (content → DB only; metadata as `DocumentInfo.ocr`), then
  re-ingests via the PdfParser's `ParseContext.ocrPages` hook → one segment per page ⇒
  page citations unchanged (proved e2e through the real retrieval path in CI with the
  fake engine). `ocr_json` survives re-index (preview + re-index reuse it; re-running
  the task overwrites); cancel persists nothing. Photos: `ImageParser` OCRs on import
  (engine injected via ParseContext — the transcriber precedent); preview re-recognizes.
- **Availability (D14/D9):** `createSelectedOcrEngine` → engine iff
  `ocr/*.traineddata.gz` exist, else null (no mock). `AppStatus.ocrAvailable` gates the
  offer + the photo mention; absent assets ⇒ notice + "needs the OCR files" hint. The
  `ocrLanguages` settings key was dropped — availability-driven, no key (D14).
- **D32 as built:** `runtime-sources.yaml` `ocr:` block (new asset class: plain files,
  sha256 = install state, no marker), `fetch-runtime --family ocr`, `planOcrDownloads`
  in assets.ts, `assertCommercialDrive.ocrAssetsVerified` + both script gates,
  `ocr/` in `DRIVE_LAYOUT_DIRS` + prepare-drive scripts, `/ocr/` git-ignored.
  Packaged builds `asarUnpack` tesseract.js + tesseract.js-core (worker_threads cannot
  read asar; workerPath rewritten to `.unpacked`) — release-acceptance smoke recorded.
- **Verification:** +38 CI tests (detection fixtures, fake-engine task integration
  incl. cancel/guards/re-run, photo pipeline, factory/engine offline wiring, ocr-block
  validation, planOcrDownloads, no-CDN sentinel over src/, preload channel contract);
  `PAID_OCR_SMOKE` manual harness PASSED on the real assets (confidence 95, zero remote
  connect attempts under a net watch); the built-app eyeball walk PASSED both legs —
  the real hidden-window → tesseract → re-ingest pipeline recognized the German scan
  fixture (umlauts/ß exact) and a photo imported straight to Ready.

---

## 12. Cross-cutting impact inventory

- **DB:** `messages_fts` (+triggers) · `documents.summary_json`, `documents.origin_json`,
  `documents.ocr_json` (additive `ensureColumn`) · no doc-task results table (D28:
  materialized documents instead).
- **Settings (whitelisted additions):** none strictly required for 31/33–35 (availability-
  driven, D14 precedent); Phases 36/37/38 added none either — manifest/binary/asset
  presence gates everything (the considered `ocrLanguages` key was dropped).
- **AuditEventType (additive):** `workspace_password_changed`, `document_task_completed`
  (+`_failed`) — ids/kinds only; searches and dictation are deliberately NOT audited
  (content-adjacent reads).
- **IPC:** `chat:search`, `workspace:changePassword`, `doctasks:start/get/cancel`,
  `dictation:transcribe` (+ preload mirrors). All follow existing patterns (request/response
  or async-with-polling; no new event channels).
- **Session hardening (audit):** the deny-by-default `setPermissionRequestHandler` (§10) —
  **SHIPPED with Phase 31** (`services/permissions.ts`); **Phase 37 added the single scoped
  `media` (audio-only, own-WebContents) allow** — documented in `security-model.md`.
- **Drive layout:** `runtime/whisper.cpp/<os>/`, `models/transcriber/` (manifest-driven,
  role-named like `models/reranker`), `ocr/` traineddata (Phase 38) — `drive.ts` `DRIVE_LAYOUT_DIRS` + both
  script families + `drive-layout.md`.
- **Commercial pipeline:** `assertCommercialDrive` + `build-commercial-drive` learn the
  whisper family (markers, backend checks) and the OCR asset set (`ocrAssetsVerified` +
  native hash gates in both scripts); `verify-models --generate`
  covers whisper weights via the normal manifest path.
- **Docs at each phase's end (per the ritual):** `architecture.md` (task service, second
  sidecar family), `rag-design.md` (nothing — retrieval untouched), `security-model.md`
  (password change, descriptor v2, dictation temp files), `model-policy.md` (whisper +
  tesseract licenses), `user-guide.md` (every user-visible feature), `drive-layout.md`,
  `known-limitations.md` (m4a descope, OCR speed, summary ceiling), `PRIVACY.md` (mic use,
  all-local OCR/ASR), BUILD_STATE §1/§3/§5.

## 13. Decisions (review round 1 resolved 2026-06-11; D31/D32 resolve with their research gates; D34 resolved by R-W1 + D35 resolved with Phase 36; D36 added + resolved with Phase 34; D37 added + resolved with Phase 35)

| # | Decision | Resolution |
|---|---|---|
| D23 | Search ranking | **RESOLVED (round 1):** bm25 with newest-first tie-break; revisit with use |
| D24 | Password-change mechanism | **RESOLVED (round 1): (b) envelope descriptor v2, migrate-on-first-change** — a random data key wrapped by the password-derived KEK; first change pays the one-time v1→v2 bulk re-encrypt (journaled swap), every later change is an atomic single-file re-wrap. O(1) recurring change, atomic commit point, unlocks future key features (recovery codes, rotation); v1 vaults untouched until they opt in. Direct re-encrypt and migrate-on-unlock rejected |
| D25 | Summary persistence + long-doc strategy | **RESOLVED (round 1):** `documents.summary_json` + budgeted map-reduce with hard ceiling + honest `truncated` flag. Alternatives (summary-as-conversation, unbounded map-reduce) rejected: surface sprawl / CPU latency |
| D26 | Doc-task concurrency vs chat | **RESOLVED (round 1): strict one-at-a-time** — tasks serialize among themselves (one queue), a task refuses to start while a chat answer is streaming, and a chat message sent while a task runs gets friendly copy ("A document task is running — you can cancel it"). Tasks are cancellable so the user is never stuck. R-T1 demoted to informational (see §14); revisit parallelism only with evidence |
| D27 | Translation output form | **RESOLVED (round 1): materialized corpus document** ("<original> (Deutsch)") + `origin_json` provenance — searchable/citable/exportable, encrypted for free. Export-only and a dedicated results panel rejected (results leave the workspace / a whole new surface). **Implemented in Phase 34 (§7)** |
| D36 | Translation input: chunks vs re-parse | **RESOLVED (Phase 34, 2026-06-11): re-extract the parser's SEGMENTS from the stored copy** (the `extractDocumentPreview` path) and window them with the D25 budget math. Stored chunks overlap by ~80 tokens — in-order concatenation duplicates text at every boundary, which a summary tolerated (D25) but a faithful translation cannot; trimming the overlap out of adjacent chunks was rejected as heuristic (chunk text is whitespace-normalized) where the re-parse is exact. Cost = one re-parse, same as the in-app preview. Regression-tested (every source word exactly once in the output) |
| D28 | Compare result form + big-doc strategy | **RESOLVED (round 1): materialized "Comparison: A vs B" document** (same principle as D27, `origin_json` records both source ids); auto mode-switch full-stuff vs section-matched (vector-paired) by token math. No new result tables. **Implemented in Phase 35 (§8)** |
| D37 | Compare mode-(a) input + mode decision: chunks vs re-parse | **RESOLVED (Phase 35, 2026-06-11): re-extract the parser's SEGMENTS** (the D36 path) for mode (a)'s input AND for the mode decision itself. Two reasons beyond D36's: chunk overlap would present duplicated text as phantom "shared" content to a comparison, and the ~80-token overlap inflates a chunk-based length estimate by ~16% — enough to mis-route a fitting pair into the heavier mode (b). Mode (b)'s map step deliberately uses the stored CHUNKS instead (the pairing needs their vectors; per-pair notes tolerate overlap like summary partials, D25 precedent). Regression-tested (every source word exactly once in the mode-(a) prompt) |
| D29 | Timestamp representation | **RESOLVED (round 1):** whisper segments → `sectionLabel: "mm:ss–mm:ss"` (existing `Citation.section` surfaces it). No schema change |
| D30 | Dictation capture pipeline | **RESOLVED (round 1):** renderer MediaRecorder → OfflineAudioContext resample → WAV bytes → main temp file (shredded) → transcriber; mic via scoped `setPermissionRequestHandler`. Streaming ASR explicitly out of scope. **Implemented in Phase 37 (§10) exactly as locked** |
| D31 | OCR execution context | **RESOLVED (Phase 38, 2026-06-11, by R-O1): the split design** — a hidden BrowserWindow does ONLY the pdf→PNG rasterization (it is the sole context with a canvas: R-O1 probed the Electron-37 `utilityProcess` and found NO OffscreenCanvas/DOM globals at all, killing option (b)); recognition ALWAYS runs MAIN-side in tesseract.js **Node mode** on image-file Buffers (no canvas needed — probed in BOTH runtimes), where the worker script + WASM core load from local `node_modules` with zero CDN involvement. Photos never touch the renderer at all. The renderer↔main round-trip carries only page PNGs |
| D32 | OCR asset distribution | **RESOLVED (Phase 38, 2026-06-11, by R-O2's inventory): ride `runtime-sources.yaml` with a new additive `ocr:` asset class** (plain verified files `{ lang, url, sha256, dest }`, no extraction, no per-OS variance), fetched by `fetch-runtime`'s Phase-36 `--family` mechanism. The drive carries ONLY the traineddata (`ocr/<lang>.traineddata.gz` — tesseract.js reads the `.gz` layout natively, single hash per file); the worker JS + WASM core ship inside the app as the pinned npm deps. A dedicated `fetch-ocr` script family was rejected: two small files don't justify a third script family when the family mechanism already exists |
| D33 | OCR trigger | **RESOLVED (round 1): never automatic for PDFs** — detection notice + explicit "Make searchable (OCR)" cancellable task with progress; photos OCR on import (small, fast). Auto-on-import and a settings toggle rejected (silent slow imports / a key + two code paths before the feature exists) |
| D34 | Whisper invocation mode | **RESOLVED (Phase 36, 2026-06-11, by R-W1): per-file CLI, not a server.** The v1.8.6 zip ships BOTH `whisper-cli.exe` and `whisper-server.exe` — but only for Windows, so "server ships per-OS" (the lean-server condition) fails; and the CLI wins on merits for batch-only use: progressive `-pp` progress + segments while it works (the R-W4 signal), no multi-hundred-MB upload over loopback, no port/health lifecycle, cancel/lock-suspend = kill the child. The localhost-only sidecar rule is moot (no socket). Revisit server mode only if Phase-37 dictation latency demands a warm model |
| D35 | Audio originals on the drive | **RESOLVED (Phase 36, 2026-06-11): keep the copy** — the locked Phase-4 copy-into-workspace contract + `reindexDocument` re-parsing the stored file force it (transcript-only storage would break re-index and the self-contained drive). Shipped with the recommended riders: size-aware import confirmation (>50 MB picked audio, `docs:importPreflight`), honest "Transcribing… N%" progress on import AND re-index, re-index = full re-transcription recorded in `known-limitations.md`. A sha256-keyed transcript cache only on evidence. Bonus that fell out of the packing design: preview/translate/compare read the STORED CHUNKS (exact for audio — no overlap by construction), so only re-index pays the re-transcription |

## 14. Research gates (consolidated — do these BEFORE the affected phase)

| Gate | Question | Method | Blocks |
|---|---|---|---|
| R-S1 | FTS5 `snippet()`/`highlight()` present in both runtimes? | **RESOLVED — GO (probed 2026-06-11):** Electron 37.10.3 main process AND system Node 24.13.0, both SQLite 3.50.4: `snippet()`, `highlight()`, `bm25()` all work on a self-contained fts5 table. JS-truncation fallback not needed | 31 (fallback exists) |
| R-T1 | llama-server b9585 concurrent-request behavior (slots/queue/reject)? | **RESOLVED — probed 2026-06-11** (`tests/manual/server-concurrency-probe.test.ts`, `PAID_CONCURRENCY_PROBE`, real b9585 + Qwen3-4B on the dev box): at our default spawn args a second `/v1/chat/completions` is served on a **PARALLEL slot** (continuous batching) — request B fired 1.5 s into A's stream got its first token at +212 ms and finished while A was still streaming (A: first token 49 ms, done 4 386 ms, 700 tok; B: first token 1 718 ms, done 1 791 ms). Not queued, not rejected ⇒ the D26 app-side guard is the ONLY serialization, which is exactly why it exists (predictable latency, no context splitting). Facts banked for a future parallelism revisit | nothing (informational; D26 stands) |
| R-T2 | 4B-class quality: long-input translation drift; comparison-format adherence | **Translation half RESOLVED — probed 2026-06-11** (`tests/manual/translation-smoke.test.ts`, `PAID_TRANSLATION_SMOKE`, real pinned b9585 + Qwen3-4B-instruct-q4 on the dev box, the SHIPPING prompts at temp 0.2). Findings: **(1) refusals/chatter: none** — no "Here is the translation", no refusal phrases, and an adversarial embedded-instruction window was translated, not obeyed. **(2) Language drift: none** on a near-budget (~1100-word) EN→DE input — head and tail both fully German (function-word scoring de=42/44, en=0/0). **(3) Markdown survival: complete** (h1/h2/bullets/table pipes/bold/blockquote all preserved DE→EN). **(4) Output↔input length — the load-bearing finding:** word ratios are ~1.0–1.1 (DE→EN) and ~0.94 (EN→DE), but German output costs **~2 real tokens per source word** (subword-heavy compounds): the first run's half-input/half-output context split CAPPED a near-budget window at `maxTokens` (ratio 0.67, output cut mid-sentence — silent truncation, exactly what this gate exists to catch). **Fix shipped:** the usable context now splits by measured weight — input 1.3 tok/word, output 2.0 (`TRANSLATION_OUTPUT_TOKENS_PER_WORD`); at 4096 ctx → 1150-word windows, `maxTokens` 2301. Re-run: 19/19 numbered sections present, no truncation. **(5)** Number VALUES/names/codes survive; formats localize (14.03.2026 → March 14, 2026) — accepted, documented. **Retry policy set:** one retry, then visible marking (failures were not observed; truncation is handled by sizing, not retries). **Comparison half RESOLVED — probed 2026-06-11** (`tests/manual/compare-smoke.test.ts`, `PAID_COMPARE_SMOKE`, real pinned b9585 + Qwen3-4B-instruct-q4 on the dev box, the SHIPPING prompts at temp 0.3, two rounds). Findings: **(1) the 4B holds the dictated four-section report format** — all four `##` headings verbatim and exactly once in EVERY report probe (EN pair, DE pair, reduce), clean bullets, zero refusals/chatter, no truncation (reports ran 106–221 words against the 512-token cap ⇒ `COMPARE_OUTPUT_TOKENS = 512` confirmed; comparison output is summary-shaped — a fixed cap, not a per-word weight). **(2) Fact placement:** shared + differing facts land correctly, names/numbers/dates exact. Round 1 caught two real issues: only-in-one facts were ALSO cross-listed under "What differs", and the matched-pair map step silently MISSED an only-in-A fact (exactly the silent-omission class this gate exists for). **Round-2 prompt fixes shipped:** an exactly-ONE-section instruction (fixed the reduce; mode (a) still cross-lists one-sided clauses under "differs" — accurate but redundant, accepted + documented in known-limitations) and a "check every fact in the section of A" recall instruction (fixed the map miss — 4/4 prefixed bullets, all 6 planted facts present in round 2). **(3) Mode (b) DOES need the smaller per-pair format (plan §8's flag was right)** — compact `- Same:/- Different:/- Only in A/B:` bullets held perfectly at a 256-token map cap. **(4) Reduce over per-pair notes:** four sections back, duplicate shared facts merged to one bullet, exclusive placement correct, no inventions. **(5) German inputs:** the report body stays German (function-word score de=14 vs en=3, facts exact); the DICTATED section headings stay English — cosmetic, recorded in known-limitations. **R-T2 fully resolved** | nothing (both halves resolved — 34 + 35 shipped) |
| R-W1 | Pinned whisper.cpp release: binaries per OS, server vs CLI, JSON timestamp output, license, archive shapes + hashes | **RESOLVED — probed 2026-06-11** against the real `ggml-org/whisper.cpp` release assets (GitHub API + fresh downloads). **Pin: v1.8.6** (2026-06-02). Findings: **(1) prebuilt binaries exist for WINDOWS ONLY** — `whisper-bin-x64.zip` (plain CPU, 3.9 MB, sha256 `b07ea0b1…0a822`) plus Win32/BLAS/CUDA variants and an Apple xcframework; NO mac/linux CLI assets ⇒ mac/linux = a documented source-build step. **(2)** The zip nests everything under `Release/` (the existing flatten step handles it) and contains BOTH `whisper-cli.exe` AND `whisper-server.exe` + ggml DLLs + SDL2.dll (zlib license). **(3) D34 → CLI** (see §13). **(4)** `-oj` JSON shape verified: `transcription[].offsets.{from,to}` in ms + `text`, `result.language`. **(5)** License MIT ("the ggml authors", 2023-2026, verified at the tag); model weights MIT (OpenAI) — reviews recorded in `model-policy.md` | 36 — done |
| R-W2 | Decodable input formats of the pinned binary (mp3? flac? m4a?) | **RESOLVED — probed 2026-06-11** with real files against the real v1.8.6 binary. The binary itself declares + decodes **wav, mp3, flac, ogg** (all four verified incl. real German mp3/ogg; ogg was an upside surprise vs the plan's wav/mp3/flac guess). **m4a: NOT decodable — and the failure mode is the trap this gate existed for: whisper-cli EXITS 0** with "failed to read audio data" on stderr and NO output. ⇒ the transcriber treats "JSON exists and parses" as the only success signal, never the exit code; m4a is descoped with friendly convert-to-WAV/MP3 copy | 36 — done (format promise = wav/mp3/flac/ogg) |
| R-W3 | Whisper model size for DE+EN on the reference laptop (RTF, RAM) | **RESOLVED — probed 2026-06-11** (dev box, 4 threads; TTS German with known ground truth + real LibriVox German speech). **base** (142 MB): RTF ≈ 0.17–0.21 but meaning-destroying word errors on real speech ("Leichenwagen"→"gleichen Wagen", "Töchter"→"Teuchter", "Särge"→"sehrge", "Magd"→"Markt"). **small** (466 MB): RTF ≈ 0.43–0.46 (~2.4× the cost), fixes nearly all of them; clean-speech German near-perfect with numbers/names/dates exact in both. **Shipped default: `small`** (German quality is the product promise); real hashes captured for both (base banked for a possible future low-end manifest: `60ed5bc3…2efe`). All profiles recommended (peak RSS ≈ 1.2 GB, batch job) | 36 — done (manifest = whisper-small-multilingual) |
| R-W4 | 60-min file: time/memory/progress signal | **RESOLVED — probed 2026-06-11**: a real 52-min German mp3 (128 kbps LibriVox) through the small model on the dev CPU (4 threads): **2123 s wall (≈35 min, RTF ≈ 0.68), peak working set 1155 MB**, 616 segments, **`-pp` progress lines every ~5% (20 ticks) + segments streamed progressively to stdout** ⇒ the import job shows real per-file "Transcribing… N%" (shipped: CLI `-pp` → ParseContext.onProgress → in-memory map → `DocumentInfo.transcriptionProgress` on the existing polling path — no new channel). Memory is a non-issue; wall time is the honest cost recorded in `known-limitations.md` + the size-aware import confirm (D35) | 36 — done (job UX = per-file percent) |
| R-O1 | pdfjs render-to-OffscreenCanvas in utilityProcess/worker; tesseract.js on Node Buffers w/o canvas | **RESOLVED — probed 2026-06-11** in the pinned Electron 37.10.3 AND system Node 24.13.0 (two-runtime discipline), tesseract.js pinned 7.0.0. **(1) `utilityProcess` has NO OffscreenCanvas** — nor `document`, `createImageBitmap`, `ImageData`, `DOMMatrix`, or `Path2D` (all `undefined`); D31 option (b) is impossible in the Electron we pin. **(2) A hidden BrowserWindow renders fine:** the pinned pdfjs LEGACY build rasterized page 1 of a real image-only PDF at 300 DPI (2550×3301) in ~350 ms with an explicit LOCAL `workerSrc`. **(3) tesseract.js Node mode consumes image-file Buffers WITHOUT canvas in BOTH runtimes** (PNG + JPEG decoded inside the WASM core): confidence 95, near-perfect German incl. umlauts/ß. **(4) Full split-pipeline e2e proved in the pinned Electron:** hidden-renderer render → PNG bytes over IPC → main-side recognize, confidence 94, all six probe words (`Auftragsbestätigung`, `Großmann`, `Bürostühle`, `Schloßallee`, `Özdemir`, `Grüßen`) exact. → D31 resolved (split design) | 38 — done |
| R-O2 | Full vendored-asset inventory for offline tesseract.js + licenses + sizes | **RESOLVED — probed 2026-06-11** (source inspection + live probes with a `net.Socket.connect` watch — the offline-guard mechanism — installed). **Node-mode inventory:** workerPath defaults to the LOCAL `tesseract.js/src/worker-script/node/index.js`; the WASM core is `require`d from the LOCAL `tesseract.js-core` package (SIMD variant picked at runtime) — both ship INSIDE the app as npm deps, NOT on the drive. **The two runtime-fetch traps:** `langPath` defaults to `https://cdn.jsdelivr.net/npm/@tesseract.js-data/...` (MUST be set to the drive's `ocr/` dir) and the traineddata cache writes into CWD by default (MUST set `cacheMethod: 'none'`). Browser-mode defaults (worker + core from cdn.jsdelivr.net) are irrelevant in the split design — no tesseract code runs in a renderer. **No-network proof: zero remote connect attempts across every probe** (worker init + recognize, both runtimes, render leg included). **Licenses (all reviewed per model-policy.md):** tesseract.js 7.0.0 Apache-2.0 · tesseract.js-core 7.0.0 Apache-2.0 · traineddata Apache-2.0 (tesseract-ocr upstream). **Shipped sizes:** `deu.traineddata.gz` 1.27 MB + `eng.traineddata.gz` 2.82 MB ≈ 4.1 MB total. **Packaged-app caveat:** `worker_threads` cannot load a script from inside `app.asar` → `asarUnpack` tesseract.js + tesseract.js-core and resolve workerPath through `.unpacked` (release-acceptance item; the green gate never packages). → D32 resolved | 38 — done |
| R-O3 | `fast` vs `best` traineddata on real German scans | **RESOLVED — probed 2026-06-11** on generated German office-scan pages (umlauts, ß, „"-quotes, numbers; 150-DPI clean + ~82-DPI/JPEG-q0.45 degraded variants). **Load-bearing finding: true `tessdata_best` (float) CRASHES the tesseract.js WASM core** (`missing function: DotProductSSE`) — only INTEGER models run, so the real choice is `fast` vs `best_int` (integerized best — what tesseract.js's own CDN default uses). Clean scan: a dead tie (103/104 words exact for both; only the typographic `×`→`x`). Degraded scan: **best_int 3 misses vs fast 7 of 104** — fast garbles the reference number `4711-Ä/2026` and `Jürgen`, best_int keeps both. Cost: ~1.3 s vs ~0.8 s per page (i7 dev box), +1.6 MB on the drive. **Shipped: `best_int`** (`@tesseract.js-data/{deu,eng}@1.0.0`, `4.0.0_best_int`, sha256 pinned in runtime-sources.yaml). The `.gz`-on-drive layout (`langPath` + `gzip: true`) verified end-to-end | 38 — done |

## 15. Testing posture (held from waves 1–2)

CI stays **zero-network / zero-model / zero-binary / zero-GPU / zero-mic**: fake
transcriber/OCR engines behind the same injection seams as the embedder/reranker; MockRuntime
drives every doc-task path; FTS and crypto tests run on temp DBs; renderer tests via jsdom +
stubbed preload. New manual harnesses behind env vars (existing pattern):
`PAID_WHISPER_SMOKE`, `PAID_OCR_SMOKE`, plus R-T1/R-T2 probes. Every phase ends on the
standard gate: typecheck clean, full suite green, build green, docs + BUILD_STATE updated,
phase commit.
