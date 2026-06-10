# Post-MVP Functionality — wave 3 working paper (Phases 31–38)

_Status: **WORKING PAPER — NOT IMPLEMENTED** (drafted 2026-06-10). Per the CLAUDE.md doc
lifecycle rule this is a plan document: once a phase is implemented its section condenses
into a design record and the durable content moves to the topic docs. Phases 29–30 are
reserved by [`model-catalog-expansion-plan.md`](model-catalog-expansion-plan.md); this wave
starts at **Phase 31**. Decisions continue the project-wide numbering at **D23** (D1–D7
wave 1 · D8–D15 retrieval · D16–D22 catalog · D-UI1–4 UI wave)._

The eight features (user-selected 2026-06-10):

| Phase | Feature | Size | Hard dependency | New deps / sidecars |
|---|---|---|---|---|
| 31 | Conversation search | S | none | none (FTS5 already proven) |
| 32 | Vault password change | S–M | none | none (`@noble/hashes` already shipped) |
| 33 | Document tasks foundation + one-click summary | M | none | none |
| 34 | Document translation workflow | S–M | Phase 33 (task machinery) | none |
| 35 | Compare two documents | M | Phase 33 (task machinery) | none |
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

## 2. Facts the plan rests on (verified in code, 2026-06-10)

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
   (→ D26). The llama-server slot count (default parallelism) needs a probe (R-T1).
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
- **32 second:** small surface but security-critical; D24 (envelope vs re-encrypt) deserves
  its own review round before code, like the Phase-22 key-management precedent. No other
  phase depends on it; do it early because vault code changes want maximal soak time before
  a release.
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

## 4. Phase 31 — Conversation search

**Goal:** a search box over past conversations — "what did it tell me about the liability
cap last week?" — local, instant, encrypted at rest like everything else in the DB.

**Design sketch.** Mirror the D13 index shape: `messages_fts = fts5(content, message_id
UNINDEXED)` — self-contained (NOT external-content; same VACUUM rationale), three sync
triggers on `messages` (insert / delete / update-of-content), guarded migration + one-time
backfill in `openDatabase`. Reuse `buildFtsMatchQuery` for sanitization (export it from
`hybrid.ts` or lift to a shared module). New `searchMessages(db, query, limit)` in
`services/chat.ts` joining hits → `messages` → `conversations`, returning
`{ conversationId, conversationTitle, messageId, role, snippet, createdAt, bm25 }` grouped
by conversation. Snippets via FTS5's `snippet()` function (verify available — R-S1; fallback:
truncate around the first match in JS). New IPC `chat:search` + preload `searchConversations`.
UI: search input atop `ConversationList.tsx`; result rows navigate to the conversation
(message-level scroll-to is a nice-to-have, not required).

**Contracts touched:** none locked. DB gains one virtual table + triggers (inside the
encrypted file — search index is encrypted at rest for free). Locked workspace: the `db`
getter throws while locked → search is simply unavailable pre-unlock, like everything else.

**Privacy:** queries and snippets are CONTENT — **no audit event for searches** (reads are
not audited today; keep it that way), nothing logged.

**Where to look in detail:**
- `db.ts` `chunks_fts` migration block — the exact guarded-migration + backfill shape to
  replicate, incl. how it detects "table exists but empty".
- `deleteConversation` (`chat.ts`) — confirm message deletes fire the FTS delete trigger
  (they go through SQL DELETE, so yes — but the test must assert it).
- R-S1: probe `snippet()`/`highlight()` in BOTH runtimes (Electron main + system Node),
  the §1.2 two-runtime precedent.
- Ranking: bm25 alone vs bm25 blended with recency (D23).

**Tests:** migration + backfill on a pre-existing DB fixture; trigger sync incl.
conversation delete; sanitizer reuse; ranking determinism; renderer test for the search UI;
sentinel test that no audit row is written on search.

## 5. Phase 32 — Vault password change

**Goal:** Settings → "Change password": current password + new password (Phase-27 strength
hint component reused from the first-run flow) + confirm; works for argon2id AND legacy
scrypt vaults; crash-safe.

**The load-bearing decision (D24).** Fact §2.3: data is encrypted under the password-derived
key directly, so there are exactly two designs:

- **(a) Direct re-encrypt:** derive new key (fresh salt, `DEFAULT_KDF` — a scrypt vault
  silently upgrades to argon2id), re-encrypt `paid.sqlite.enc` + EVERY `<id><ext>.enc`
  document, write new descriptor. No format change, but cost scales with corpus size and
  the crash window spans many files — needs a journal/two-phase commit (write all `.new`,
  fsync, swap descriptor LAST as the commit point, then GC).
- **(b) Envelope migration (descriptor v2):** introduce a random 32-byte **data key**;
  the password-derived KEK wraps it (AES-256-GCM blob in the descriptor). Password change
  = re-wrap ONE blob + new verifier — atomic single-file descriptor replace, O(1) regardless
  of corpus size. Cost: a v1→v2 migration moment (on unlock or on first password change,
  re-encrypting everything ONCE under the new data key — the same machinery (a) needs
  anyway), plus a permanent two-key concept in `security/crypto.ts`.

**Recommendation: (b), migrate-on-password-change** (not on unlock — don't touch working
vaults that never change their password). (b) is also the prerequisite for every future
key feature (multiple unlock passwords, recovery codes, Phase-22-adjacent rotation), and it
makes the *recurring* operation trivially atomic instead of making *every* change a bulk
re-encryption. The one-time v1→v2 bulk re-encrypt reuses (a)'s journaled swap as the
migration step.

**Mechanics regardless of D24:** must run UNLOCKED (key in memory); verify current password
via the existing verifier first; `WorkspaceController` gains `changePassword(current, next)`;
re-lock cleanly afterwards is NOT required (key object is replaced in place). New audit event
`workspace_password_changed` (additive `AuditEventType`; id-free, content-free). New IPC
`workspace:changePassword`. **Plaintext_dev mode: feature hidden** (nothing to change).

**Where to look in detail:**
- `workspace-vault.ts` `create()`/`unlock()`/`lock()` + `documentCipher()` — every place the
  key is held or used; how many artifacts are encrypted under it (DB + N documents); whether
  anything else (checksum cache? no — settings live inside the DB) derives from it.
- `security/crypto.ts` `makeVerifier`/`verifyKey`/`deriveKey` — where the KEK/data-key split
  lands; keep `KdfParams` per-algo validation.
- Crash-safety: the existing atomic write patterns (`encryptFile` `.tmp`-then-rename,
  `shredFile`) — the journaled swap should compose them, not invent new primitives.
- The Phase-27 first-run password step (`WorkspaceGate`) — reuse the strength hint +
  show-toggle component rather than duplicating it in Settings.

**Tests:** change-then-unlock-with-new (argon2id AND scrypt-created fixtures); old password
rejected after change; wrong current password rejected (and audited as `unlock_failed`-class,
not a new leak); simulated crash between journal steps recovers to a consistent vault
(old OR new, never mixed); descriptor never contains password/key material (extend the
existing scan test); v1→v2 migration leaves documents decryptable.

## 6. Phase 33 — Document tasks foundation + one-click summary

**Goal:** a "Summarize" action per document on the Documents screen; the summary persists,
survives reload, is marked stale on re-index — and the machinery underneath (the **document
task service**) is the shared engine for Phases 34–35.

**Document task service** (`services/doctasks.ts`): a job state machine on the Phase-4/18
async-with-polling precedent — `startDocTask({ kind: 'summary' | 'translation' | 'compare',
documentIds, params }) → { jobId }`, `getDocTask(jobId)` → `{ state, progress
{ stepsDone, stepsTotal }, error?, resultRef? }`, `cancelDocTask(jobId)`. One task at a time
(serialized queue), its own `AbortController` (NOT the per-conversation in-flight map — fact
§2.8). Tasks call the ACTIVE chat runtime via `chatStream` with explicit
`maxTokens`/`temperature` (no depth modes); runtime not running → friendly "start a model
first" failure, never an auto-start surprise (consistent with `autoStartActiveModel`
semantics — D26 refines this).

**Summary algorithm.** Inputs are the document's stored CHUNKS (no re-parse). Budget-driven
two-level map-reduce: (1) if total chunk tokens ≤ a single-pass budget (derived from
`contextTokens`, default 4096, minus prompt+output reserve), one summarization call over the
stitched text; (2) else group chunks into ~budget-sized windows → per-window partial
summaries → one reduce pass over the partials; (3) a hard ceiling (e.g. 12 map calls ≈ a
~50-page document) beyond which the summary states it covers the beginning (honest, §11.4
copy) — Deep map-reduce over a 1000-chunk corpus on a CPU laptop is not a v1 promise (D25).

**Persistence (D25):** additive nullable `documents.summary_json` (`ensureColumn` precedent)
holding `{ text, modelId, createdAt, truncated }`; cleared by `reindexDocument` (content may
have changed) and by document delete (row goes with it). Summaries are CONTENT: they live
only in the (possibly encrypted) DB, never in the audit log — event `document_task_completed`
records `{ kind, documentId }` only.

**UI:** row action "Summarize" + summary display in the existing `DocumentPreview` panel
(collapsible, "Generated by <model> · <date>" attribution line, regenerate button); progress
via the polling pattern; busy state visible on the row.

**Where to look in detail:**
- R-T1: llama-server request concurrency at b9585 defaults — what happens to an in-flight
  chat stream when a task POSTs a second `/v1/chat/completions` (queued? parallel slot?
  rejected?). Decides whether D26 must serialize tasks against chat or only against other
  tasks. Probe against the real pinned binary (the §1.1 source-verification precedent).
- `services/ingestion` chunk retrieval by document + `chunker.ts` token estimates — the
  map-window math reuses the same word≈token approximation; verify it against real chunk
  rows so windows don't overflow the context.
- `registerDocsIpc.ts` import-job polling loop in `DocumentsScreen.tsx` — the exact polling
  hook to generalize for task jobs.

**Tests:** task state machine (queue, cancel mid-stream, runtime-absent failure); window
math at the boundaries (single-pass vs map-reduce cutover, ceiling); summary persistence +
re-index invalidation; MockRuntime-driven end-to-end (CI stays zero-model); audit privacy
sentinel (no summary text in `runtime_events`); renderer polling/regenerate test.

## 7. Phase 34 — Document translation workflow

**Goal:** "Translate to German/English" on a document → a translated copy the user can read,
cite, and export. The DACH angle made concrete; the bundled models are multilingual (E5 is
multilingual; Qwen3-class chat models handle DE↔EN).

**Design sketch.** A `translation` document task: map over chunks **in order** (translation
is embarrassingly parallel but runs serialized on the one runtime), translating window-wise
with a strict instruction template (translate, don't summarize; preserve structure; keep
numbers/names verbatim), concatenate. **Output (D27): a NEW document in the corpus** —
materialize as Markdown, write into `workspace/documents/` via the normal import path
(`createQueuedDocument` + `processDocument` ⇒ it gets chunked, embedded, searchable, citable
like any import; encrypted via `DocumentCipher` automatically), titled
"<original> (Deutsch)" with a metadata link `{ translatedFrom: documentId, targetLang }` in a
`documents.origin_json` additive column. Export-to-file then comes free via the existing
save-dialog pattern. Language targets v1: `de`/`en` only (the eval-set languages) — a
free-text language field invites silent quality failures.

**Honesty requirements:** the §11.4 attribution line ("Machine-translated by <model> — may
contain errors") prepended to the materialized document; `truncated`/`failed-window`
handling must be visible, not silent (a window the model refuses/garbles marks the output,
not drops it).

**Where to look in detail:**
- Per-window failure modes on the real 4B (R-T2, manual smoke): refusal phrases, language
  drift on long inputs, markdown structure survival — sets the window size + retry policy.
- `processDocument` re-entry: importing a generated file from INSIDE the app (not via the
  picker) — confirm the path-copy + sha256 + status flow accepts a programmatic source path
  cleanly (it should: `original_path` is just recorded).

**Tests:** template assembly; window ordering + concatenation; origin metadata round-trip;
generated-document import end-to-end with MockRuntime (deterministic echo = verifiable
stitching); attribution line presence; audit ids-only.

## 8. Phase 35 — Compare two documents

**Goal:** select exactly two documents → "Compare" → a structured comparison the user can
read and keep: what's common, what differs, what exists only in one.

**The budget reality (drives D28):** two full documents almost never fit the default
4096-token context (`ragMaxContextTokens` is 2500 for retrieval). v1 therefore has two modes
selected automatically by token math: **(a) small-docs full compare** — both docs' total
chunk tokens fit the single-pass budget ⇒ one structured-comparison call over both full
texts; **(b) section-matched compare** — embed-pair sections: for each chunk of doc A,
retrieve the nearest chunks of doc B via the EXISTING `VectorIndex` scoped to doc B (fact:
`documentIds` scoping exists since Phase 17), compare matched pairs window-wise
(map), then reduce into one report (differences/additions/omissions). The vectors are
already there — this is the embeddings-leverage feature, no new index.

**Output:** a comparison REPORT persisted like a summary (`compare` task, result in a
`document_compare_results` table or — simpler — materialized as a Markdown document via the
Phase-34 path, titled "Comparison: A vs B", `origin_json` recording both source ids; D28
picks). Materializing as a document is recommended: it inherits persistence, search (Phase
31!), citations-adjacent preview, export — and avoids a new result surface.

**UI:** Documents screen already has multi-select (Phase 17 "Ask these documents") — add
"Compare (2)" enabled at exactly two selections; result opens like a document preview.

**Where to look in detail:**
- The Phase-17 selection UI in `DocumentsScreen.tsx` — reuse the same checkbox state, don't
  add a second selection mechanism.
- `VectorIndex.search` with `documentIds` scope — confirm per-chunk query cost over a large
  doc-B is fine for the linear scan (it is the SAME scan retrieval does; ~chunk-count
  cosines per A-chunk — cap A-chunks per the map ceiling).
- R-T2 (shared with 34): how well the 4B holds a 3-column comparison format — sets the
  reduce-prompt design and whether (b) needs a smaller per-pair format.

**Tests:** mode selection by token math; pairing determinism; report materialization +
origin metadata; two-doc-only gating in UI; MockRuntime e2e; audit ids-only.

## 9. Phase 36 — Audio transcription as document ingestion (whisper.cpp)

**Goal:** import `.wav`/`.mp3` (formats per R-W2) of a meeting/memo/interview → batch,
offline transcription with timestamps → a normal corpus document: chunked, embedded,
searchable, citable — citations showing time ranges ("Ask your meetings").

**Distribution (the long pole — mirrors Phases 12/14 exactly):**
- `runtime-sources.yaml` gains an additive top-level `whisper_cpp:` block (same
  `{ version, builds[] }` shape); `validateRuntimeSources` extended; extract to
  `runtime/whisper.cpp/<os>/`; `.paid-runtime.json` marker reused as-is;
  `fetch-runtime.{ps1,sh}` + `drive.ts` layout + `assertCommercialDrive` +
  `build-commercial-drive` all gain the second family. **CPU-only builds first** (E5/reranker
  precedent: ASR is a batch job; GPU whisper is a later opt-in, not a default risk).
- Whisper model weights = a normal manifest with `role: transcriber` + `download` block
  (license: MIT — review per `model-policy.md` like every model) ⇒ Phase-18 in-app
  downloader covers it with zero new code (D14 precedent). Candidate sizes: `base`/`small`
  multilingual (DE+EN) — R-W3 picks via a German-audio smoke.

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
(bytes, not a user path) → main writes a transient temp WAV (shredded after), runs the
Phase-36 transcriber, returns text. Composer inserts at cursor. Feature visible only when
the transcriber is available (availability-driven, D14 precedent). Electron needs a
`setPermissionRequestHandler` decision for the mic prompt (allow `media` from our own
renderer only — verify current handler posture, it may deny-by-default today).

**Privacy:** the recording exists only as a transient temp file, shredded
(`shredFile` exists); no audit event (content-adjacent); mic indicator is the OS's own.
Locked workspace: composer doesn't exist pre-unlock — no special handling.

**Where to look in detail:**
- The session/permission setup in `main/index.ts` (where CSP is installed) — what
  permission handler exists today; adding `media` allow must not loosen anything else.
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
- **Drive layout:** `runtime/whisper.cpp/<os>/`, `models/whisper/` (manifest-driven),
  `ocr/` assets — `drive.ts` `DRIVE_LAYOUT_DIRS` + both script families + `drive-layout.md`.
- **Commercial pipeline:** `assertCommercialDrive` + `build-commercial-drive` learn the
  whisper family (markers, backend checks) and the OCR asset set; `verify-models --generate`
  covers whisper weights via the normal manifest path.
- **Docs at each phase's end (per the ritual):** `architecture.md` (task service, second
  sidecar family), `rag-design.md` (nothing — retrieval untouched), `security-model.md`
  (password change, descriptor v2, dictation temp files), `model-policy.md` (whisper +
  tesseract licenses), `user-guide.md` (every user-visible feature), `drive-layout.md`,
  `known-limitations.md` (m4a descope, OCR speed, summary ceiling), `PRIVACY.md` (mic use,
  all-local OCR/ASR), BUILD_STATE §1/§3/§5.

## 13. Decisions (OPEN — resolve in a review round before each phase, D1–D7 precedent)

| # | Decision | Options / recommendation |
|---|---|---|
| D23 | Search ranking | bm25 only vs bm25 × recency blend. **Rec:** bm25 with newest-first tie-break; revisit with use |
| D24 | Password-change mechanism | (a) direct journaled re-encrypt vs (b) envelope descriptor v2, migrate-on-first-change. **Rec: (b)** — O(1) recurring change, atomic commit point, unlocks future key features; v1 vaults untouched until they opt in |
| D25 | Summary persistence + long-doc strategy | `documents.summary_json` + budgeted map-reduce with hard ceiling + honest `truncated` flag. Alternatives (summary-as-conversation, unbounded map-reduce) rejected: surface sprawl / CPU latency |
| D26 | Doc-task concurrency vs chat | Serialize tasks among themselves (one queue). Whether a task may run DURING a chat stream depends on R-T1 (server slots). **Rec:** v1 = refuse with friendly copy while a chat stream is in flight (simplest honest behavior) |
| D27 | Translation output form | Materialized corpus document (searchable/citable/exportable, encrypted for free) vs export-only file. **Rec:** materialized document + `origin_json` provenance |
| D28 | Compare result form + big-doc strategy | Materialized "Comparison: A vs B" document; auto mode-switch full-stuff vs section-matched (vector-paired) by token math. **Rec:** as stated; no new result tables |
| D29 | Timestamp representation | whisper segments → `sectionLabel: "mm:ss–mm:ss"` (existing `Citation.section` surfaces it). No schema change. **Rec:** as stated |
| D30 | Dictation capture pipeline | Renderer MediaRecorder → OfflineAudioContext resample → WAV bytes → main temp file → transcriber; mic via scoped `setPermissionRequestHandler`. **Rec:** as stated; streaming ASR explicitly out of scope |
| D31 | OCR execution context | Hidden renderer/worker vs `utilityProcess` + OffscreenCanvas (R-O1 decides); photos possibly main-side directly. BLOCKING for Phase 38 implementation |
| D32 | OCR asset distribution | Extend `runtime-sources.yaml` (new asset class) vs dedicated `fetch-ocr` script entry. Resolve with R-O2's asset inventory |
| D33 | OCR trigger | **Rec:** never automatic for PDFs — detection notice + explicit "Make searchable (OCR)" task; photos OCR on import |
| D34 | Whisper invocation mode | whisper-server (loopback, LlamaServer-style) vs per-file CLI. R-W1 decides; **lean server** if the pinned release ships it per-OS (lifecycle reuse), CLI otherwise |

## 14. Research gates (consolidated — do these BEFORE the affected phase)

| Gate | Question | Method | Blocks |
|---|---|---|---|
| R-S1 | FTS5 `snippet()`/`highlight()` present in both runtimes? | The §1.2 two-runtime probe script | 31 (fallback exists) |
| R-T1 | llama-server b9585 concurrent-request behavior (slots/queue/reject)? | Probe the REAL pinned binary; check `--parallel` defaults in the pinned source | 33 (D26) |
| R-T2 | 4B-class quality: long-input translation drift; comparison-format adherence | Manual smoke on the test drive (existing `PAID_*` pattern) | 34, 35 (prompt design) |
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
