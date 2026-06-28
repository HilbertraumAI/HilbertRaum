# Backend audit 2026-06-27 — remediation plan

> **Working paper.** Source of findings: [`audits/backend-audit-2026-06-27.md`](../audits/backend-audit-2026-06-27.md) (every finding ID below is defined there with file:line evidence). This plan is structured so each **phase is a self-contained unit of work runnable in a fresh session / context window**. Per CLAUDE.md's doc-lifecycle rule, fold each phase's decisions into the relevant topic doc as it ships, and **delete this plan file when all phases are done**.

## How to run a phase (read this first, every session)

1. Read [`BUILD_STATE.md`](../BUILD_STATE.md) (top entry) and the **finding IDs** for this phase in the audit report.
2. Implement the change. Keep service boundaries clean; no new network/telemetry; content-class data (document text/titles, chat, figures, redacted text) never logged/audited.
3. **Per-phase ritual (MANDATORY, from CLAUDE.md):**
   - `npm test` green (add the phase's new tests first — verify they have *teeth* by neutering the fix and seeing them fail).
   - `npm run typecheck` clean and `npm run build` OK.
   - Update affected `docs/` (fold the decision into the cited §, don't leave a dangling plan note).
   - Update `BUILD_STATE.md` (status, decisions, data contracts, next actions, risks).
   - Commit referencing the phase + finding IDs.
4. Flip this plan's phase checkbox to ✅ and record the "as built" pick in BUILD_STATE.

**Decision points** are flagged ⚠️ inside the phase — resolve them before coding (ask the owner if unsure).

**Ordering:** phases are listed by priority (High findings first). They are **largely independent** and may be reordered, with one exception: Phase 1 changes the schema/migration and the document-teardown helper that later phases may touch — do it first.

**Branch:** continue on a remediation branch (e.g. `backend-audit-2026-06-27-fixes`), or one branch per phase if you prefer smaller PRs.

---

## Phase 1 — Document-deletion data integrity (DATA-1, DOC-1, MAINT-1, TEST-1) — **High**

**Problem.** `deleteDocument` (`ingestion/index.ts:1361`) deletes chunks/embeddings/row but not `bank_statements`/`invoices`, which reference `documents(id)` with **no `ON DELETE CASCADE`** while `foreign_keys=ON`. The final `DELETE FROM documents` throws `SQLITE_CONSTRAINT_FOREIGNKEY` **after** the file was shredded and chunks/embeddings deleted → a permanently corrupt, undeletable document. Reproduced against `node:sqlite`. Contradicts known-limitations.md §39–46.

**Changes.**
1. **Centralise teardown** — add `purgeDocumentDerivatives(db, id)` (one authoritative list of everything hanging off a document: embeddings → chunks → tree_nodes → bank_corrections → bank_transactions → bank_statements → invoice_line_items → invoices, in FK order; the CASCADE tables need no manual delete). Route `deleteDocument` through it (MAINT-1).
2. **Schema** — add `ON DELETE CASCADE` to `bank_statements.document_id` and `invoices.document_id` (and confirm the child tables cascade from their parents). Because `CREATE TABLE IF NOT EXISTS` can't alter an existing FK, ⚠️ **DECISION**: either (a) a guarded table-rebuild migration (copy rows → drop → recreate with CASCADE → reinsert, inside a txn), or (b) keep the FKs as-is and rely on the ordered manual delete in `purgeDocumentDerivatives`. *Recommendation: do BOTH the manual ordered delete (immediate, safe for existing drives) AND add CASCADE to fresh schemas (defense-in-depth for the next table). The rebuild migration is optional — skip it if it's too heavy for portable drives.*
3. **Atomicity** — wrap `deleteDocument` in a single transaction (`BEGIN…COMMIT`, rollback on throw) so a future FK miss rolls back instead of half-committing. Keep `shredFile` **after** the DB commit (don't destroy the file until the row delete succeeds), or shred only on success.
4. **Reindex parity** — confirm the reindex chunk-phase delete (`index.ts:667–687`) is unaffected (it doesn't delete the document row, so no FK issue; bank/invoice rows correctly persist as stale, gated by `extractor_version`).

**Tests (TEST-1).** Integration: create a document, run `extract_transactions` (and separately `extract_invoice`) to create rows, then `deleteDocument` → succeeds, all derived rows gone, file shredded, audit event emitted. Teeth: neuter the bank cleanup → the test must fail with the FK error.

**Docs.** Update `known-limitations.md` §39–46 (the deletion-safety paragraph) to state the bank/invoice tables are handled by explicit ordered cleanup (+ CASCADE if added); update `architecture.md` "Skills — design record" §10 (the bank/invoice DDL note) and the document-organization §3 cascade note; note the new helper in `rag-design.md` §`deleteDocument` row if present.

**Definition of done.** A document with extractions deletes cleanly + atomically; the corrupt-half-delete window is closed; docs no longer contradict the code; teeth-verified test added.

---

## Phase 2 — Financial-extraction correctness (BL-1, BL-2, BL-3, TEST-2, TEST-6) — **High + Medium**

**Problem.** `MONEY_RE` reads a `dd.mm.20yy` date as an amount (BL-1) → value-date-column statements drop or mis-value rows. `assessCompleteness`/`reconcileBalances` sum across currencies (BL-2). `categoryTotals` is currency-blind (BL-3).

**Changes.**
1. **BL-1** — in `parseLine`/`parseLineItem` (`skills/tools/bank-statement.ts:103–125`), strip recognised **leading date column(s)** before the money scan (run `parseDate` on each leading whitespace token, not just the first), **or** tighten `MONEY_RE` (`money.ts:42`) with a negative lookahead so a `\d{2}` decimal tail can't be immediately followed by two digits forming a year (`(?![0-9])` after the tail, calibrated against existing fixtures). ⚠️ **DECISION**: prefer the date-stripping approach — it's robust to both leading and trailing value dates; the regex tweak is narrower. Verify against the existing bank-statement fixtures so no currently-correct parse regresses.
2. **BL-2** — make `assessCompleteness`/`isStatementComplete` and `reconcileBalances` return `unverified`/unknown when rows are not single-currency (mirror the `summarizeCashflow` `currencies.size === 1` guard).
3. **BL-3** — key `categoryTotals` by `(category, currency)` or assert single-currency input.

**Tests (TEST-2, TEST-6).** Add a 4-column `Buchung Valuta Betrag Saldo` fixture (booking + value date + amount + balance) → all rows parsed with correct amounts/descriptions, none dropped. Add a mixed-currency statement → completeness `unverified`. Teeth: revert each fix → test fails.

**Docs.** Update `architecture.md` "Skills — design record" §10 (the bank parser / completeness-gate notes) to record the value-date handling and the single-currency precondition; cross-reference the SKILL.md ⇔ TS parity contract if the honesty branches change.

**Definition of done.** Two-date statements parse correctly; mixed-currency statements never present a meaningless verified total; fixtures pin both.

---

## Phase 3 — Cancellation & timeouts (REL-1, REL-2, REL-3, REL-6, TEST-4) — **Medium**

**Problem.** Audio transcription during ingestion is uncancellable + unbounded (REL-1); OCR per-page recognition has no timeout/abort (REL-2); dictation has no timeout/cancel/concurrency guard (REL-3); transcriber transcript defaults to OS tmpdir outside the crash sweep (REL-6).

**Changes.**
1. **REL-1** — add `signal?: AbortSignal` to `ParseContext` (`ingestion/parsers/index.ts`); thread `task.controller.signal` from the ingestion call site (`ingestion/index.ts:629–635`) into `AudioParser.parse → transcribe(..., { signal })`; add a generous per-spawn watchdog in `transcriber/cli.ts run()` (kill + reject after a fixed ceiling, e.g. N× audio duration).
2. **REL-2** — wrap `worker.recognize(image)` (`ocr/tesseract.ts:120`) in `Promise.race` with a per-page timeout; on timeout/abort `terminate()` the worker (recreated lazily) and reject so the serialised chain recovers.
3. **REL-3** — pass an `AbortSignal` + max-duration timeout into the dictation `transcribe` (`registerDictationIpc.ts:41–67`); serialise or reject concurrent dictations.
4. **REL-6** — make `workDir` required in `transcriber/cli.ts:117` (drop the `tmpdir()` fallback) or fall back to a workspace `.parse`-named dir the crash sweep covers; assert/log if the default is ever taken.

**Tests (TEST-4).** Audio ingestion: abort mid-transcribe → the child is killed and the task ends cancelled (mock transcriber that blocks until signalled). OCR: a recognition that exceeds the timeout → worker terminated, chain recovers on the next page. Dictation: a second dictation while one is in flight → rejected/queued, no double-spawn.

**Docs.** Update `architecture.md` (the transcriber / OCR / dictation records) with the timeout + signal contract; add a "wedged transcription/OCR self-recovers via timeout" line to `known-limitations.md` (or remove the implicit assumption that it can hang).

**Definition of done.** No single crafted audio/image can wedge a shared worker for the session; cancel is honored mid-operation; no content lands in an unswept tmpdir.

---

## Phase 4 — Ingestion robustness & cap enforcement (REL-5, REL-9, REL-10, BL-5, MAINT-4) — **Medium + Low**

**Problem.** Preview re-parse bypasses the cap stack (REL-5); `expandPaths` symlink-cycle recursion (REL-9); `resolvePageYear` `Math.max(...spread)` stack overflow (REL-10); CSV over-wide rows truncated (BL-5).

**Changes.**
1. **MAINT-4 + REL-5** — introduce a single `parseWithLimits(parser, source, ctx, limits)` decorator used by **every** parse entry point (ingest, preview, preview-page); resolve `IngestionLimits` in the preview path and pass `maxPages`/`maxInflatedBytes` + wrap non-audio previews in `withParseTimeout` (`ingestion/index.ts:954–1014`).
2. **REL-9** — in `expandPaths` (`index.ts:1406–1432`), track visited `realpathSync` directories in a `Set` (skip already-seen) or cap recursion depth, to defeat symlink cycles.
3. **REL-10** — replace `Math.max(...ys)`/`Math.min(...ys)` in `pdf-layout.ts:443–446` with a single loop/`reduce`.
4. **BL-5** — in `csv.ts:33–39`, iterate `Math.max(header.length, row.length)` and emit bare/`colN:` values for overflow columns so no cell is silently dropped.

**Tests.** Preview a synthetic over-cap document → bounded/timed-out, not a hang. Import a folder containing a symlink cycle → terminates, no stack overflow. A PDF page with a huge fragment count in layout mode → no `RangeError`. A ragged CSV → all cells present in extracted text.

**Docs.** Update `rag-design.md` §3 (the cap stack now covers the preview path too) and the chunker/limits notes; note the symlink-cycle guard.

**Definition of done.** Every parse path enforces the same caps; no unbounded recursion/allocation in the ingestion + preview paths.

---

## Phase 5 — RAG/embeddings honesty & quality (RAG-1, EMB-1, DATA-2, EMB-4, MAINT-2, MAINT-5, TEST-3/5/7) — **Medium + Low**

**Problem.** "Across the whole document" over-claim in multi-doc scopes (RAG-1); reranker silently no-ops on CJK/Thai (EMB-1); compare-path `decodeVector` lacks the truncated-blob guard (DATA-2); codec assumes native LE with no assert (EMB-4).

**Changes.**
1. **RAG-1** — gate `coverageWhole` on `fullyChunked && scannedChunks >= totalChunks` (or scope the `fullyChunked`/total counts to documents that actually have extraction records) in `analysis/extract.ts` + `analysis/listing-answer.ts:82–84`. The honest `coverageSections` wording already exists for the partial case.
2. **EMB-1 + MAINT-2** — replace the reranker's naive whitespace `truncateWords` (`reranker/llama.ts:56–59`) with the E5 embedder's CJK/Thai-aware `truncateToApproxTokens` (a shared budget helper), sized to leave headroom under the context, so a space-less input can't exceed `n_ctx` and silently 500 the rerank pass.
3. **DATA-2 + EMB-2** — move the `blob.length < dimensions*4` guard **into** `decodeVector` (`embeddings/codec.ts`) so all callers (incl. `doctasks/manager.ts:1175,1201`) are uniformly safe.
4. **EMB-4 + MAINT-5** — add a one-line module-load LE endianness assert to `codec.ts`.

**Tests (TEST-3/5/7).** Multi-doc scope with extraction on only one doc → wording is `coverageSections`, not "whole document". A CJK passage longer than the context → reranker still returns a reordering (no silent fallback). A truncated `vector_blob` → skipped, not a thrown task.

**Docs.** Update `rag-design.md` §14 (the coverage-honesty wording gate) and §12 (the reranker truncation contract); note the codec LE assumption is now asserted.

**Definition of done.** The app never claims "whole document" without having scanned it; the reranker works on every script; a corrupt vector row degrades gracefully.

---

## Phase 6 — Skills trust model (SEC-1, DOC-5, API-3, TEST-8) — **Medium**

**Problem.** A user-imported `kind: tool` skill can drive Tier-2 tools (bank/invoice/redaction) with no trust gate; `userGrant` collapses to `declared` (SEC-1). `documentCount` is hard-coded to 1 (API-3).

⚠️ **DECISION (product) — RESOLVED by the owner: option (A), gate to app skills.** (Recorded as built in BUILD_STATE; implemented via the named `skillCanRunTools(skill)` predicate.) The options were:
- **(A) Gate to app skills** — `runnableToolNames`/`startSkillRun` (`tool-runs.ts:93`, `registerSkillsIpc.ts:299`) refuse unless `source === 'app'` until a real per-tool user-grant UI exists. *Recommended* (matches the "trusted product content" mental model; smallest surface). ✅ **CHOSEN.**
- **(B) Allow + document** — keep user `kind:tool` skills runnable, but document the posture explicitly and add the per-tool grant decision to the import-warning/confirm flow.

**Changes.** Implement the chosen gate; either way make the trust decision **explicit** (not incidental). API-3: leave `documentCount` as-is for v1 but add a comment/TODO that it must become real if multi-document tools land (no behavior change).

**Tests (TEST-8).** A user-imported `kind:tool` skill → `runnableToolNames` returns `[]` (option A) or runs with the documented confirm (option B); an app skill → unchanged. Teeth: flip the gate → test fails.

**Docs.** Update `security-model.md` "Skill-import defences" and `architecture.md` §7/§23 to state the trust posture explicitly (DOC-5).

**Definition of done.** Whether user tool-skills can run Tier-2 tools is a documented, tested, deliberate decision.

---

## Phase 7 — Electron hardening & vision/runtime defense-in-depth (SEC-2, SEC-3, SEC-5, SEC-6, REL-4, REL-7, REL-8, SEC-4) — **Low (cluster)**

**Problem.** Missing `setPermissionCheckHandler` (SEC-2) and `will-redirect` guard (SEC-3); `imageAnalyze` raw bytes not token-bound (SEC-5); `decodedPixelCount=null` disables the pixel cap (SEC-6); OCR PDF page PNG has no byte cap (REL-4); sidecar/GPU-probe spawns omit `windowsHide` (REL-7); GPU probe not tracked by `shutdown()` (REL-8); binary-verifier session-cache TOCTOU is undocumented (SEC-4).

**Changes.**
1. **SEC-2** — install `setPermissionCheckHandler` mirroring `permissions.ts` (deny-by-default, audio/dictation from the app origin only).
2. **SEC-3** — attach the `will-navigate` predicate to `will-redirect` on the main + OCR windows.
3. **REL-7** — add `windowsHide: true` to `runtime/sidecar.ts:329` and `runtime/gpu.ts:118`.
4. **SEC-6** — treat a `null` pixel count for a claimed png/jpeg as suspicious (reject or stricter byte cap) in `vision/limits.ts`.
5. **REL-4** — add a byte cap on the returned OCR page PNG (`renderer/ocr/main.ts` / `rasterizer.ts`) mirroring `VISION_MAX_IMAGE_BYTES`.
6. **REL-8** — `child.unref()` the GPU probe and/or register it so `shutdown()` can kill it.
7. **SEC-5 + SEC-4** — *documentation only*: record the `imageAnalyze` raw-bytes boundary and the session-scoped (not per-spawn) binary-verifier TOCTOU as accepted residuals in `security-model.md`.

**Tests.** Unit: permission check handler denies non-audio; a `will-redirect` to a remote origin is blocked; an oversized OCR PNG is rejected; a null-pixel-count claimed image is rejected.

**Docs.** Update `security-model.md` (permission-check, redirect guard, the two documented residuals) and `architecture.md` (windowsHide, GPU-probe lifecycle).

**Definition of done.** Electron hardening is complete (check + request + redirect); vision/OCR byte caps are symmetric; accepted residuals are on record.

---

## Phase 8 — API consistency, doc drift & housekeeping (API-1, BL-4, DATA-3, DATA-4, DOC-2, DOC-3, DOC-4, API-2, MAINT-3) — **Low + Info**

**Problem.** Chat IPC throws a raw lock error (API-1); redaction date-locale gap undocumented (BL-4); `summary_cache` unbounded (DATA-3/MAINT-3); doc drift (DOC-2/3/4); minor notes (DATA-4, API-2).

**Changes.**
1. **API-1** — add a `requireUnlocked()` preamble (localized via `tMain`) to the DB-touching chat handlers in `registerChatIpc.ts`, matching the docs/collections/doctasks pattern.
2. **DATA-3 + MAINT-3** — add a simple age/size eviction for `summary_cache` (and a diagnostics counter), or — if eviction is deferred — at minimum surface the unbounded growth in `known-limitations.md`. ⚠️ **DECISION**: implement eviction vs document-only. *Recommendation: a cheap age cap + count metric.*
3. **Docs (DOC-2/3/4)** — fix `rag-design.md` §3 "Cap" to describe over-cap rejection (DOC-2); add the E5 no-prefix retrieval ceiling (DOC-3) and the `summary_cache` growth (DOC-4) to `known-limitations.md`.
4. **BL-4** — note the redaction date-locale asymmetry (US-ordered / 2-digit-year dates can slip through; names/addresses unmasked) in `known-limitations.md`.
5. **DATA-4** — optional: add `ORDER BY chunk_index` to `documentApproxTokenTotal` for consistency. **API-2** — no code change; it's a documented residual (leave as-is).

**Tests.** A locked-vault chat IPC call → friendly localized message (not the raw engine string). If eviction is implemented: a `summary_cache` past the cap is pruned.

**Docs.** All the doc fixes above; final pass to ensure no plan note dangles.

**Definition of done.** Locked-vault chat returns a friendly message; doc drift resolved; `summary_cache` growth is bounded or documented.

---

## Phase 9 — Close-out

When Phases 1–8 are ✅: fold any remaining live status into the relevant topic-doc § (the audit's per-finding dispositions), update the audit report's status (or leave it as the historical record), update `BUILD_STATE.md` with the all-phases-remediated note, and **delete this plan file** (the full original stays in git history) per CLAUDE.md's doc-lifecycle rule.

---

## Phase tracker

- [x] Phase 1 — Document-deletion data integrity (DATA-1, DOC-1, MAINT-1, TEST-1) — **High** ✅ (branch `backend-audit-2026-06-27-fixes`; ordered manual delete + full-chain CASCADE on fresh schemas, txn-wrapped, shred-after-commit; `purgeDocumentDerivatives`/`purgeSkillDataForDocument`; teeth-verified test)
- [x] Phase 2 — Financial-extraction correctness (BL-1, BL-2, BL-3) — **High/Med** ✅ (branch `backend-audit-2026-06-27-fixes`; BL-1 leading-date strip via shared `money.ts splitLeadingDates` in `parseLine`/`parseLineItem` — value date captured, line-parser fallback only; BL-2 single-currency precondition on `assessCompleteness`/`reconcileBalances` mirroring `summarizeCashflow`; BL-3 `categoryTotals` keyed by `(category, currency)`; 4-column Buchung/Valuta + mixed-currency fixtures, BL-1/BL-2 teeth-verified; parity contract unchanged)
- [x] Phase 3 — Cancellation & timeouts (REL-1, REL-2, REL-3, REL-6) — **Med** ✅ (branch `backend-audit-2026-06-27-fixes`; REL-1 inactivity watchdog in `transcriber/cli.ts` + `AbortSignal` threaded `IngestionDeps.signal`→`ParseContext.signal`→`AudioParser`→`transcribe`, per-job abort on mid-job lock; REL-2 `Promise.race` per-page OCR timeout + terminate-on-timeout/abort recovery in `tesseract.ts`; REL-3 dictation single-flight guard + wall-clock abort; REL-6 `TranscribeOptions.workDir` now required, no tmpdir fallback; +8 teeth-verified tests; tuning envs `HILBERTRAUM_WHISPER_IDLE_TIMEOUT_MS`/`HILBERTRAUM_OCR_PAGE_TIMEOUT_MS`/`HILBERTRAUM_DICTATION_TIMEOUT_MS`)
- [x] Phase 4 — Ingestion robustness & caps (REL-5, REL-9, REL-10, BL-5, MAINT-4) — **Med/Low** ✅ (branch `backend-audit-2026-06-27-fixes`; MAINT-4+REL-5 single `parseWithLimits` decorator now routes ingest + both preview readers through the SAME cap stack — preview gains `maxPages`/`maxInflatedBytes`/wall-clock timeout, audio exempt, ingest byte-for-byte unchanged; REL-9 symlink-cycle guard in `expandPaths` via recursion-path `realpathSync` Set; REL-10 single-pass y-range fold in `resolvePageYear`; BL-5 ragged-CSV overflow cells kept under `colN:`; +11 teeth-verified tests, suite 2311/39)
- [x] Phase 5 — RAG/embeddings honesty & quality (RAG-1, EMB-1, DATA-2, EMB-4) — **Med/Low** ✅ (branch `backend-audit-2026-06-27-fixes`; RAG-1 `buildListingAnswer` gates "whole document" on `fullyChunked && scannedChunks >= totalChunks` — multi-doc partial scope falls to "sections scanned", single-doc unchanged; EMB-1+MAINT-2 reranker drops naive `truncateWords` for CJK/Thai-aware `truncateToApproxTokens` via the SHARED `runtime/context-budget.ts` helper, per-field caps clamped to the context budget so a space-less input can't 500 the pass, fused-order fallback kept as backstop; DATA-2/EMB-2 truncated-blob guard moved INTO `decodeVector` (now `Float32Array | null`) so all 4 call sites incl. the 2 compare-path decodes skip uniformly; EMB-4/MAINT-5 module-load LE assert in `codec.ts`; +4 teeth-verified tests, suite 2315/39; DOC-3 left for Phase 8)
- [x] Phase 6 — Skills trust model (SEC-1, API-3, DOC-5, TEST-8) — **Med** ✅ (branch `backend-audit-2026-06-27-fixes`; DECISION as built: **option A — gate Tier-2 tools to APP skills**; one named predicate `skillCanRunTools(skill)` = `source === 'app'` at the runnable-tools choke point `runnableToolNames` (so `listRunnableTools` + the run bar offer a user `kind:tool` skill nothing) + belt-and-braces re-check at `startSkillRun` refusing a forged IPC call with the generic content-free `run.unavailable` string; a user skill KEEPS its declared `allowedTools` for a future per-tool grant UI but runs none — parser untouched; API-3 `documentCount` left v1 constant `1` + in-code TODO; +4 teeth-verified tests in `skills-tool-run-ipc.test.ts`, suite 2319/39; docs: security-model.md Tier-2 §ceiling SEC-1 record + architecture.md §7/§23)
- [x] Phase 7 — Electron + vision/runtime hardening (SEC-2/3/4/5/6, REL-4/7/8) — **Low** ✅ (branch `backend-audit-2026-06-27-fixes`; SEC-2 `installPermissionCheckHandler` mirrors the request handler via a SHARED `grantsMicrophone` predicate — both deny-by-default except app-origin audio, wired in `index.ts`; SEC-3 new `services/navigation-guard.ts` `installNavigationGuard` attaches ONE deny-predicate to BOTH `will-navigate` AND `will-redirect` on the main window (allow own shell) + the OCR hidden window (deny-all); REL-7 `windowsHide: true` on the sidecar (`sidecar.ts`, every model start) + GPU-probe (`gpu.ts`) spawns; SEC-6 `validateAnalyzeRequest` rejects a claimed png/jpeg with a `null` pixel count as `decodeFailed` (no more byte-cap-only fall-through); REL-4 new electron-free `services/ocr/page-cap.ts` (`OCR_MAX_PAGE_PNG_BYTES`=96 MiB sized for a worst-case 4096² RGBA scan, env `HILBERTRAUM_MAX_OCR_PAGE_BYTES`) rejects an over-cap page PNG in `rasterizer.ts`; REL-8 `child.unref()` on the GPU probe so a wedged probe can't delay quit; SEC-5/SEC-4 recorded as accepted residuals in `security-model.md`; +11 teeth-verified tests (permissions/navigation-guard/ocr-page-cap/vision-limits) + vision-integration fixtures updated to valid PNG headers, suite 2330/39; docs: security-model.md (perm-check + redirect guard + SEC-5/SEC-4 residuals + SEC-6) and architecture.md (windowsHide on sidecar+probe, probe unref lifecycle, OCR page byte cap, vision SEC-6))
- [ ] Phase 8 — API consistency, doc drift & housekeeping — **Low/Info**
- [ ] Phase 9 — Close-out (fold records, delete this plan file)
