# Post-MVP Functionality — wave 3 working paper (Phases 31–38)

_Status: **WORKING PAPER — Phases 31–35 DONE 2026-06-11 (§4/§5/§6/§7/§8 are their
condensed design records; the §12 session-hardening rider shipped with 31; R-T1 resolved
with 33; R-T2 FULLY resolved — translation half with 34 (D36), comparison half with 35
(D37); Phases 36–38 NOT IMPLEMENTED** (drafted
2026-06-10; **review round 1 resolved
2026-06-11**: D23–D30 + D33 locked, see §13; D31/D32/D34 stay open by design — they resolve
with research gates R-O1/R-O2/R-W1. **Plan audit 2026-06-11:** every §2 fact re-verified
against the code; findings folded in — the mic-permission posture correction in §10 (no
handler exists; Electron default-ALLOWS), the `models/transcriber/` naming fix, the D35
audio-storage decision flagged by the re-index contract, staleness guards in §7/§8, and the
verified forward-compatibility of an additive `whisper_cpp` block in §9). Per the CLAUDE.md doc lifecycle rule this is a plan
document: once a phase is implemented its section condenses into a design record and the
durable content moves to the topic docs. Phases 29–30 are reserved by
[`model-catalog-expansion-plan.md`](model-catalog-expansion-plan.md); this wave starts at
**Phase 31**. Decisions continue the project-wide numbering at **D23** (D1–D7 wave 1 ·
D8–D15 retrieval · D16–D22 catalog · D-UI1–4 UI wave)._

The eight features (user-selected 2026-06-10):

| Phase | Feature | Size | Hard dependency | New deps / sidecars |
|---|---|---|---|---|
| 31 | Conversation search — **✅ DONE 2026-06-11** | S | none | none (FTS5 already proven) |
| 32 | Vault password change — **✅ DONE 2026-06-11** | M | none | none (`@noble/hashes` already shipped) |
| 33 | Document tasks foundation + one-click summary — **✅ DONE 2026-06-11** | M | none | none |
| 34 | Document translation workflow — **✅ DONE 2026-06-11** | S–M | Phase 33 (task machinery) | none |
| 35 | Compare two documents — **✅ DONE 2026-06-11** | M | Phase 33 (task machinery) | none |
| 36 | Audio transcription as ingestion (whisper.cpp) | L | research gates R-W1..R-W4 | **whisper.cpp sidecar family + whisper GGML weights** |
| 37 | Voice dictation in the composer | S–M | Phase 36 (transcriber) | none beyond 36 |
| 38 | Scanned-PDF / photo OCR | M–L | research gates R-O1..R-O3 | **tesseract.js (WASM) + vendored traineddata** |

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

## 9. Phase 36 — Audio transcription as document ingestion (whisper.cpp)

**Goal:** import `.wav`/`.mp3` (formats per R-W2) of a meeting/memo/interview → batch,
offline transcription with timestamps → a normal corpus document: chunked, embedded,
searchable, citable — citations showing time ranges ("Ask your meetings").

**Distribution (the long pole — mirrors Phases 12/14 exactly):**
- `runtime-sources.yaml` gains an additive top-level `whisper_cpp:` block (same
  `{ version, builds[] }` shape); `validateRuntimeSources` extended. **Verified (audit
  2026-06-11):** the current validator reads ONLY the `llama_cpp` key and ignores unknown
  siblings (`shared/runtime-sources.ts:61`), so the new block is genuinely additive — an
  older app on a newer drive parses the file unchanged. Extract to
  `runtime/whisper.cpp/<os>/`; `.paid-runtime.json` marker reused as-is;
  `fetch-runtime.{ps1,sh}` + `drive.ts` layout + `assertCommercialDrive` +
  `build-commercial-drive` all gain the second family. **CPU-only builds first** (E5/reranker
  precedent: ASR is a batch job; GPU whisper is a later opt-in, not a default risk).
- Whisper model weights = a normal manifest with `role: transcriber` + `download` block
  (license: MIT — review per `model-policy.md` like every model) ⇒ Phase-18 in-app
  downloader covers it with zero new code (D14 precedent); weights live in
  `models/transcriber/` (the role-named `models/reranker` convention, NOT `models/whisper` —
  audit naming fix). Candidate sizes: `base`/`small` multilingual (DE+EN) — R-W3 picks via a
  German-audio smoke.

**Storage + re-index reality (D35, flagged by the audit):** the locked Phase-4 contract
copies every import into `workspace/documents/` AND `reindexDocument` re-parses the stored
file — so the audio copy must be KEPT (transcript-only storage would break re-index), it is
encrypted on encrypted workspaces (a multi-hundred-MB recording costs real encrypt/shred
time and drive space), and **a re-index of an audio document = a full re-transcription**.
v1 answer: keep the copy, add a size-aware import confirmation for large audio, honest
"Transcribing…" progress on re-index, and a `known-limitations.md` entry; a sha256-keyed
transcript cache (checksumCache precedent) only if re-index proves common.

**Runtime service** (`services/transcriber/`): `Transcriber` interface with availability
selection (`createSelectedTranscriber` → real iff binary + weights, else **null**, no mock —
the reranker D9 pattern), lazy lifecycle, will-quit stop, lock-time suspend. Whether it
composes `LlamaServer`-style (whisper-server over loopback) or invokes the CLI per file is
**R-W1** — the server gives health/port reuse, the CLI is simpler for batch-only use; decide
from the pinned release's actual artifacts.

**Ingestion integration:** a new `AudioParser implements DocumentParser`
(`extensions: ['.wav', '.mp3', …]` per R-W2) whose `parse()` calls the injected transcriber
and maps whisper segments → `ExtractedSegment{ text, sectionLabel: "mm:ss–mm:ss" }`
(page-less ⇒ the txt/md dedup rule applies — fact §2.4; citations show the time range via the
existing `section` field, zero citation changes — D29). Parser construction needs the
transcriber injected — extend `IngestionDeps` (the embedder-injection precedent). Transcriber
absent → the file fails friendly ("Audio import needs the transcription model — download it
on the AI Model screen") with the documents-table error path, never a throw. Encrypted
workspaces: the stored audio is `.enc`; re-index decrypts to the transient `.parse<ext>`
(existing pattern) for the transcriber.

**Research gates (ALL before implementation — the Phase-21 discipline):**
- **R-W1 — pinned whisper.cpp release:** pick the tag; confirm prebuilt win/mac/linux
  binaries exist (or define the build story), server vs CLI mode, output format with
  segment timestamps (JSON), license (MIT expected), archive shapes for the fetch scripts.
  Verify against the release's REAL assets, hashes captured like b9585.
- **R-W2 — input formats:** recent whisper.cpp decodes wav/mp3/flac via bundled miniaudio;
  **m4a/aac likely NOT supported** without ffmpeg (which we will NOT bundle — license +
  surface). Scope = what the pinned binary actually decodes; m4a explicitly descoped with a
  friendly "convert to mp3/wav" message if so. This gate exists to right-size the user
  promise BEFORE the UI advertises formats.
- **R-W3 — model choice:** German+English quality vs size vs CPU speed for `base` vs
  `small` (real-time factor on the i7-1185G7 reference laptop); sets the default manifest
  + `recommended_profiles`.
- **R-W4 — long-file behavior:** a 60-minute meeting on CPU — runtime, memory, whether the
  import job needs per-segment progress (whisper emits progressively) vs a single
  "Transcribing…" state.

**Tests:** parser-with-fake-transcriber (segment mapping, timestamp labels, absent-transcriber
failure copy); runtime-sources validation for the second family; fetch-script marker logic
(extended fixtures); selector availability matrix; manual smoke
`tests/manual/whisper-smoke.test.ts` behind `PAID_WHISPER_SMOKE` (real binary + real German
audio on the test drive — the GPU-smoke pattern). Audit: `document_imported` already covers
it (filename + id only).

## 10. Phase 37 — Voice dictation into the chat composer

**Goal:** push-to-talk in the composer: hold/click to record, release → transcribe locally →
text appears in the input for review (never auto-sent).

**Design sketch (D30).** Renderer: `getUserMedia` audio → `MediaRecorder` (webm/opus) →
decode + resample to 16 kHz mono PCM via `OfflineAudioContext` → encode WAV in JS (pure
renderer, no new deps) → hand the bytes to main over a new IPC `dictation:transcribe`
(bytes, not a user path) → main writes a transient temp WAV using the **`.parse` infix
convention** (so the startup `shredStalePlaintext` crash sweep covers it — the
documented ingestion-temp pattern, `ingestion/index.ts:367`), shredded after → runs the
Phase-36 transcriber, returns text. Composer inserts at cursor. Feature visible only when
the transcriber is available (availability-driven, D14 precedent).

**Permission posture (AUDIT CORRECTION 2026-06-11):** the codebase has **no
`setPermissionRequestHandler` at all**, and Electron's default with no handler is to
**GRANT** permission requests — the opposite of the drafted assumption. Phase 37 must
install a **deny-by-default** handler with a single `media` (audio) exception for our own
renderer. That handler is an independent hardening win (it closes geolocation/
notifications/etc. for any renderer content) — small enough to land with whatever wave-3
phase ships first rather than waiting for Phase 37.

**Privacy:** the recording exists only as a transient temp file, shredded
(`shredFile` exists); no audit event (content-adjacent); mic indicator is the OS's own.
Locked workspace: composer doesn't exist pre-unlock — no special handling.

**Where to look in detail:**
- The session setup in `main/index.ts` (where CSP is installed) — the right install site
  for the deny-by-default permission handler; the `media` allow must not loosen anything
  else (audited: no handler exists today, see above).
- Whether the transcriber accepts stdin/bytes or only file paths (R-W1 output) — decides
  the temp-file shape.
- Composer focus/undo behavior on insert (`renderer/chat/Composer.tsx`).

**Tests:** WAV encode round-trip (pure function, unit-testable); IPC temp-file lifecycle
incl. shred-on-error; availability gating in the composer (renderer test); permission
handler scope test.

## 11. Phase 38 — Scanned-PDF / photo OCR

**Step 0 (small, may ship early in any phase):** image-only-PDF **detection**: PdfParser
yields ~zero text across pages ⇒ document fails with friendly copy ("This PDF looks like a
scan — it has no readable text yet") instead of silently indexing nothing. Pure trust fix,
Phase-17 spirit, no OCR needed.

**Goal (full):** image-only PDFs and photos (`.png`/`.jpg`) become searchable documents via
local OCR (tesseract.js WASM; German + English).

**The architectural wrinkle (D31):** ingestion is main-process; the main process has **no
canvas/DOM** (fact §2.10), and rendering a PDF page to pixels needs one. node-canvas is a
native dep (against the theme). Options: **(a)** OCR work runs in a hidden renderer/worker
context (pdfjs renders pages to canvas; tesseract.js runs in the same context; results
return over IPC) — keeps zero native deps, adds a renderer↔main ingestion round-trip;
**(b)** Electron `utilityProcess` with an OffscreenCanvas — cleaner isolation IF pdfjs
renders there (R-O1 must prove it). Photos need no rendering — tesseract.js consumes
image bytes directly in either design (and Node-side for photos may work without canvas —
R-O1 checks that too, which could split the design: photos in main, PDFs via renderer).

**Offline vendoring (R-O2, the licensing/offline gate):** tesseract.js by default fetches
worker JS, the WASM core, and `*.traineddata` from CDNs at runtime — **all three must be
vendored on the drive** (`ocr/` dir in the layout: core + worker + `deu`/`eng` traineddata)
and wired via explicit `workerPath`/`corePath`/`langPath`. Licenses to review: tesseract.js
(Apache-2.0), tesseract-core WASM (Apache-2.0), traineddata (Apache-2.0) — per
`model-policy.md` like every shipped asset; sizes recorded (`fast` vs `best` variants —
pick via R-O3 quality check on real German scans). Distribution rides `runtime-sources.yaml`
or a new asset class in the fetch scripts (decide in D32 — it is NOT a model manifest; it
has no GGUF semantics).

**Trigger semantics (D33):** OCR is SLOW on CPU — recommendation: never automatic. Detection
(step 0) marks the document; the row offers "Make searchable (OCR)" which runs OCR as a
document task (Phase-33 machinery: progress, cancel) and re-ingests the recognized text
(per-page `ExtractedSegment{ pageNumber }` ⇒ page citations work). Photos: parser accepts
them and OCRs on import directly (small, single image) — asymmetry justified by size.

**Where to look in detail:**
- **R-O1:** can pdfjs (our pinned legacy build) render to an OffscreenCanvas in a
  `utilityProcess`/worker, and can tesseract.js consume Node Buffers for photos without
  canvas? Probe BOTH in the Electron we pin (two-runtime discipline).
- **R-O2:** the exact vendored-asset set + the no-network proof (run with the offline guard
  watching — zero remote attempts).
- **R-O3:** recognition quality `fast` vs `best` on real German office scans (umlauts,
  ß) — sets the shipped traineddata variant and size budget.
- `DocumentPreview` — OCR'd documents should show per-page text like PDFs do today.

**Tests:** detection heuristic fixtures (true scan, hybrid text+scan, normal PDF); the OCR
context's IPC contract with a fake OCR engine; vendored-path resolution (no CDN URLs —
sentinel grep for the CDN hosts in the bundle); page-number preservation → citations;
manual smoke behind `PAID_OCR_SMOKE` with a real scan fixture on the test drive.

---

## 12. Cross-cutting impact inventory

- **DB:** `messages_fts` (+triggers) · `documents.summary_json`, `documents.origin_json`
  (additive `ensureColumn`) · optionally a doc-task results shape (D28 prefers
  materialized documents instead).
- **Settings (whitelisted additions):** none strictly required for 31/33–35 (availability-
  driven, D14 precedent); Phase 38 may add `ocrLanguages`; Phase 36/37 need none (manifest +
  binary presence gate everything).
- **AuditEventType (additive):** `workspace_password_changed`, `document_task_completed`
  (+`_failed`) — ids/kinds only; searches and dictation are deliberately NOT audited
  (content-adjacent reads).
- **IPC:** `chat:search`, `workspace:changePassword`, `doctasks:start/get/cancel`,
  `dictation:transcribe` (+ preload mirrors). All follow existing patterns (request/response
  or async-with-polling; no new event channels).
- **Session hardening (audit):** the deny-by-default `setPermissionRequestHandler` (§10) —
  **SHIPPED with Phase 31** (`services/permissions.ts`, no exceptions yet; Phase 37 adds the
  scoped `media` allow); documented in `security-model.md`.
- **Drive layout:** `runtime/whisper.cpp/<os>/`, `models/transcriber/` (manifest-driven,
  role-named like `models/reranker`), `ocr/` assets — `drive.ts` `DRIVE_LAYOUT_DIRS` + both
  script families + `drive-layout.md`.
- **Commercial pipeline:** `assertCommercialDrive` + `build-commercial-drive` learn the
  whisper family (markers, backend checks) and the OCR asset set; `verify-models --generate`
  covers whisper weights via the normal manifest path.
- **Docs at each phase's end (per the ritual):** `architecture.md` (task service, second
  sidecar family), `rag-design.md` (nothing — retrieval untouched), `security-model.md`
  (password change, descriptor v2, dictation temp files), `model-policy.md` (whisper +
  tesseract licenses), `user-guide.md` (every user-visible feature), `drive-layout.md`,
  `known-limitations.md` (m4a descope, OCR speed, summary ceiling), `PRIVACY.md` (mic use,
  all-local OCR/ASR), BUILD_STATE §1/§3/§5.

## 13. Decisions (review round 1 resolved 2026-06-11; D31/D32/D34 resolve with their research gates; D35 added by the same-day audit; D36 added + resolved with Phase 34; D37 added + resolved with Phase 35)

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
| D30 | Dictation capture pipeline | **RESOLVED (round 1):** renderer MediaRecorder → OfflineAudioContext resample → WAV bytes → main temp file (shredded) → transcriber; mic via scoped `setPermissionRequestHandler`. Streaming ASR explicitly out of scope |
| D31 | OCR execution context | **OPEN (by design):** hidden renderer/worker vs `utilityProcess` + OffscreenCanvas — R-O1 decides; photos possibly main-side directly. BLOCKING for Phase 38 implementation |
| D32 | OCR asset distribution | **OPEN (by design):** extend `runtime-sources.yaml` (new asset class) vs dedicated `fetch-ocr` script entry. Resolve with R-O2's asset inventory |
| D33 | OCR trigger | **RESOLVED (round 1): never automatic for PDFs** — detection notice + explicit "Make searchable (OCR)" cancellable task with progress; photos OCR on import (small, fast). Auto-on-import and a settings toggle rejected (silent slow imports / a key + two code paths before the feature exists) |
| D34 | Whisper invocation mode | **OPEN (by design):** whisper-server (loopback, LlamaServer-style) vs per-file CLI. R-W1 decides; lean server if the pinned release ships it per-OS (lifecycle reuse), CLI otherwise |
| D35 | Audio originals on the drive | **OPEN (flagged by the 2026-06-11 audit; resolve in the Phase-36 review):** the locked Phase-4 copy-into-workspace contract + `reindexDocument` re-parsing the stored file force KEEPING the audio copy (transcript-only breaks re-index), and re-index = full re-transcription. **Rec:** keep the copy + size-aware import confirm + `known-limitations.md` entry; sha256-keyed transcript cache only on evidence (§9) |

## 14. Research gates (consolidated — do these BEFORE the affected phase)

| Gate | Question | Method | Blocks |
|---|---|---|---|
| R-S1 | FTS5 `snippet()`/`highlight()` present in both runtimes? | **RESOLVED — GO (probed 2026-06-11):** Electron 37.10.3 main process AND system Node 24.13.0, both SQLite 3.50.4: `snippet()`, `highlight()`, `bm25()` all work on a self-contained fts5 table. JS-truncation fallback not needed | 31 (fallback exists) |
| R-T1 | llama-server b9585 concurrent-request behavior (slots/queue/reject)? | **RESOLVED — probed 2026-06-11** (`tests/manual/server-concurrency-probe.test.ts`, `PAID_CONCURRENCY_PROBE`, real b9585 + Qwen3-4B on the dev box): at our default spawn args a second `/v1/chat/completions` is served on a **PARALLEL slot** (continuous batching) — request B fired 1.5 s into A's stream got its first token at +212 ms and finished while A was still streaming (A: first token 49 ms, done 4 386 ms, 700 tok; B: first token 1 718 ms, done 1 791 ms). Not queued, not rejected ⇒ the D26 app-side guard is the ONLY serialization, which is exactly why it exists (predictable latency, no context splitting). Facts banked for a future parallelism revisit | nothing (informational; D26 stands) |
| R-T2 | 4B-class quality: long-input translation drift; comparison-format adherence | **Translation half RESOLVED — probed 2026-06-11** (`tests/manual/translation-smoke.test.ts`, `PAID_TRANSLATION_SMOKE`, real pinned b9585 + Qwen3-4B-instruct-q4 on the dev box, the SHIPPING prompts at temp 0.2). Findings: **(1) refusals/chatter: none** — no "Here is the translation", no refusal phrases, and an adversarial embedded-instruction window was translated, not obeyed. **(2) Language drift: none** on a near-budget (~1100-word) EN→DE input — head and tail both fully German (function-word scoring de=42/44, en=0/0). **(3) Markdown survival: complete** (h1/h2/bullets/table pipes/bold/blockquote all preserved DE→EN). **(4) Output↔input length — the load-bearing finding:** word ratios are ~1.0–1.1 (DE→EN) and ~0.94 (EN→DE), but German output costs **~2 real tokens per source word** (subword-heavy compounds): the first run's half-input/half-output context split CAPPED a near-budget window at `maxTokens` (ratio 0.67, output cut mid-sentence — silent truncation, exactly what this gate exists to catch). **Fix shipped:** the usable context now splits by measured weight — input 1.3 tok/word, output 2.0 (`TRANSLATION_OUTPUT_TOKENS_PER_WORD`); at 4096 ctx → 1150-word windows, `maxTokens` 2301. Re-run: 19/19 numbered sections present, no truncation. **(5)** Number VALUES/names/codes survive; formats localize (14.03.2026 → March 14, 2026) — accepted, documented. **Retry policy set:** one retry, then visible marking (failures were not observed; truncation is handled by sizing, not retries). **Comparison half RESOLVED — probed 2026-06-11** (`tests/manual/compare-smoke.test.ts`, `PAID_COMPARE_SMOKE`, real pinned b9585 + Qwen3-4B-instruct-q4 on the dev box, the SHIPPING prompts at temp 0.3, two rounds). Findings: **(1) the 4B holds the dictated four-section report format** — all four `##` headings verbatim and exactly once in EVERY report probe (EN pair, DE pair, reduce), clean bullets, zero refusals/chatter, no truncation (reports ran 106–221 words against the 512-token cap ⇒ `COMPARE_OUTPUT_TOKENS = 512` confirmed; comparison output is summary-shaped — a fixed cap, not a per-word weight). **(2) Fact placement:** shared + differing facts land correctly, names/numbers/dates exact. Round 1 caught two real issues: only-in-one facts were ALSO cross-listed under "What differs", and the matched-pair map step silently MISSED an only-in-A fact (exactly the silent-omission class this gate exists for). **Round-2 prompt fixes shipped:** an exactly-ONE-section instruction (fixed the reduce; mode (a) still cross-lists one-sided clauses under "differs" — accurate but redundant, accepted + documented in known-limitations) and a "check every fact in the section of A" recall instruction (fixed the map miss — 4/4 prefixed bullets, all 6 planted facts present in round 2). **(3) Mode (b) DOES need the smaller per-pair format (plan §8's flag was right)** — compact `- Same:/- Different:/- Only in A/B:` bullets held perfectly at a 256-token map cap. **(4) Reduce over per-pair notes:** four sections back, duplicate shared facts merged to one bullet, exclusive placement correct, no inventions. **(5) German inputs:** the report body stays German (function-word score de=14 vs en=3, facts exact); the DICTATED section headings stay English — cosmetic, recorded in known-limitations. **R-T2 fully resolved** | nothing (both halves resolved — 34 + 35 shipped) |
| R-W1 | Pinned whisper.cpp release: binaries per OS, server vs CLI, JSON timestamp output, license, archive shapes + hashes | Inspect the release's real assets (b9585 discipline) | 36 (D34) |
| R-W2 | Decodable input formats of the pinned binary (mp3? flac? m4a?) | Feed real files to the real binary | 36 (format promise) |
| R-W3 | Whisper model size for DE+EN on the reference laptop (RTF, RAM) | Manual smoke, German audio | 36 (manifest) |
| R-W4 | 60-min file: time/memory/progress signal | Same smoke | 36 (job UX) |
| R-O1 | pdfjs render-to-OffscreenCanvas in utilityProcess/worker; tesseract.js on Node Buffers w/o canvas | Probe inside the pinned Electron | 38 (D31 — BLOCKING) |
| R-O2 | Full vendored-asset inventory for offline tesseract.js + licenses + sizes | Build a no-network spike with the offline guard watching | 38 (D32) |
| R-O3 | `fast` vs `best` traineddata on real German scans | Quality spike on fixtures | 38 (shipped variant) |

## 15. Testing posture (held from waves 1–2)

CI stays **zero-network / zero-model / zero-binary / zero-GPU / zero-mic**: fake
transcriber/OCR engines behind the same injection seams as the embedder/reranker; MockRuntime
drives every doc-task path; FTS and crypto tests run on temp DBs; renderer tests via jsdom +
stubbed preload. New manual harnesses behind env vars (existing pattern):
`PAID_WHISPER_SMOKE`, `PAID_OCR_SMOKE`, plus R-T1/R-T2 probes. Every phase ends on the
standard gate: typecheck clean, full suite green, build green, docs + BUILD_STATE updated,
phase commit.
