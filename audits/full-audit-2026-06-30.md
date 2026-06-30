# Full audit — HilbertRaum — 2026-06-30

> Multi-persona read-only audit (security, backend correctness, reliability, renderer, performance,
> testing, documentation), run on `master` at commit `7281a2e` (the merge of the 2026-06-29 follow-up
> full audit, all 8 phases). This is a **working-paper report**: once each finding is dispositioned,
> fold the lasting content into the topic-doc §§ and retire this file per the CLAUDE.md doc-lifecycle
> rule (mirrors §24/§25/§26/§34/§38).
>
> **Posture of this round:** the codebase is *exceptionally* well-audited. Ledgers run through
> architecture.md §38; the prior rounds closed every Critical/High and most Medium/Low items. This
> audit deliberately **excludes** all dispositioned/accepted residuals (SEC-1c/2/3, REL-5, the money
> residuals, PERF-2 chat windowing, E5 prefix migration, etc.) and reports only findings that are
> **new on current master**, each verified against the actual code. **No Critical and no
> remote-exploitable issue** (offline by construction). The headline new items are one financial
> false-negative (C1), two scalability hot paths (P1/P2), and a cluster of stale post-refactor docs
> (D1–D5) left by the Phase-8 DX-1/DX-3 relocations.

---

## 1. Executive summary

### Overall health
Very good. The app is mature, defensively coded, and unusually well-tested (≈2593 passing / 39 skipped).
Crypto/vault, the IPC lock-guard surface, child-process spawn hardening, the model-slot arbiter, sidecar
teardown, and financial whole-string parsing are all in strong shape and were re-verified clean here.
The remaining findings are mostly **latent / defense-in-depth**, **scale cliffs that don't bite at
today's typical library sizes**, or **doc drift**. There is one user-facing correctness bug worth
prioritizing (C1) and two concrete performance wins (P1/P2).

### Highest-priority risks
1. **C1 (Med-High) — false balance-reconciliation `mismatch` on a correct statement.** A transaction row
   that prints an amount but no running balance (same-day grouping, or an OCR-dropped balance cell) breaks
   the running-balance chain, so the next balance-bearing row is judged against a stale predecessor balance
   *with the gap row's amount omitted* → false `mismatch` → `assessCompleteness` returns `contradicted` →
   the verified total is **withheld from the user on a perfectly-correct statement**. Also contradicts the
   function's own docstring. This is the inverse of the cardinal confidently-wrong harm, but equally
   trust-damaging.
2. **P1 (High @ scale) — multi-second main-thread freeze on large document compares.** `compare.ts`
   computes O(N_A × N_B × dim) cosine similarities with a per-A-chunk sort, on the main thread (where
   `node:sqlite` and IPC also live), using the *slow* `cosineSimilarity` variant instead of the
   `dotProduct` fast path the rest of the codebase uses on already-normalized vectors. Two ~1000-chunk
   docs ≈ 0.77 billion FLOPs + 1000 sorts.
3. **D1–D5 (High for future agents) — the doctasks design record is stale.** The Phase-8 DX-1/DX-3
   refactors relocated the run-handlers into `doctasks/handlers/*` and split the Documents screen, but the
   architecture.md "Document tasks" module map, the `doctasks.ts` barrel comment, and several perf-record
   citations still point at the pre-refactor files. A future agent reading the as-built source of truth is
   sent to the wrong files.

### Biggest opportunities
- **Two cheap, low-risk perf wins** (P1 `dotProduct` + running top-K; P2 resident-map iteration on the
  unfiltered scope) remove the dominant per-query/per-compare main-thread cost without the deferred
  worker-thread project.
- **Close the lock-path persistence race (R1)** the same way the quit path was hardened in follow-up
  Phase 6 — make persistence deterministic instead of relying on `runtime.stop()` outrunning the
  abort-unwind.
- **A small documentation reconciliation pass (D1–D10)** restores the topic docs as the as-built source
  of truth after the Phase-8 relocations — pure docs/comments, no code risk.

### Areas checked and found clean (explicitly)
Vault crypto (Argon2id/AES-GCM, fresh IV per op, key zeroing, journaled v1→v2 rekey); the full IPC
lock-guard / capability-token surface (one parity gap, S3); child-process spawn (4 sites, array args, no
shell, binary re-hash-before-spawn); network/telemetry (no autoUpdater/crashReporter/analytics; sidecars
bind 127.0.0.1; downloads HTTPS-only, redirect-revalidated, size-capped, verify-before-trust); skills
code-execution surface (no eval/require over package files; static tool registry; zip-slip/bomb guards);
DB indexing (every hot filter indexed); the resident-vector cache contract (exact add/remove ids at all
three write sites); the arbiter happy path; combineSignals timer cleanup; the financial whole-string
correctness suite.

---

## 2. Findings

Severity = impact if left unfixed. Confidence = certainty the finding is real on current master.
"Latent" = not a live bug today but a hazard a plausible change makes reachable.

### Correctness / business logic

#### C1 ✅ — `reconcileBalances` breaks the running-balance chain across a balance-less row → false `mismatch` → correct total withheld
- **Category:** Correctness (financial) · **Severity:** Medium-High · **Confidence:** High (logic confirmed; real-world prevalence Medium)
- **✅ Phase A (2026-06-30, branch `audit-2026-06-30-phaseA-financial` — behavior-changing, parsing-only):** `reconcileBalances` now carries a `sinceLastPrinted` cents accumulator — a balance-less row stays `unknown` (it prints no balance to check) but its amount is folded into the NEXT printed balance's expected value (`toCents(prevBalance) + sinceLastPrinted + toCents(row.amount)`), reset on each printed balance and discarded at the baseline. Since `amount` is a required `number` on `TransactionInput`/the schema, the chain is never "genuinely broken" by a missing amount → the audit's revert-to-`unknown`-on-missing-amount branch is **vacuous** (verified; documented in the docstring rather than written). Docstring aligned to the mid-statement behavior. `BANK_EXTRACTOR_VERSION` **NOT bumped** — reconcile runs on read from the persisted rows (`validate_statement_balances` / `run.ts`), not from a persisted blob, so statuses/`reconciled` re-validate automatically. Characterization-first: 5 RED→GREEN tests in `skills-bank-statement-tool.test.ts` (gap ties out → `['unknown','unknown','ok']` / `reconciled:true` / `complete`; two consecutive gaps; genuine break → `mismatch` / `contradicted`; the normal 2-figure de-AT row + the HVB no-balance listing byte-identical). Teeth: neuter the accumulator → exactly the two gap tests red; restored.
- **Location:** `apps/desktop/src/main/services/skills/tools/bank-statement.ts:566-591`
- **Description:** `prevBalance` is updated only when a row prints a balance (`if (printed !== undefined) prevBalance = printed`) and is **never reset** on a balance-less row. So when a mid-statement row has a real `amount` but no printed `balanceAfter` (same-day grouping where the bank prints the balance only on the day's last line, or an OCR-dropped balance cell), the *next* balance-bearing row computes `expected = lastPrintedBalance + thisRowAmount`, **omitting the gap row's amount**, and reports `mismatch`. This also contradicts the function's own docstring (line 543: "A row is `unknown` when it **or its predecessor** prints no balance"), which the code honors only for the *leading* baseline (`prevBalance === null`), not mid-statement gaps.
- **Evidence:**
  ```ts
  } else {
    const expected = toCents(prevBalance) + toCents(row.amount)   // omits any gap-row amounts
    if (toCents(printed) === expected) { status = 'ok'; okCount++ }
    else { status = 'mismatch'; mismatchCount++ }
  }
  if (printed !== undefined) prevBalance = printed                 // never reset on a gap row
  ```
  Trace `[bal 100] → [amount −10, no balance] → [amount −20, bal 70]`: true chain 100→90→70 ties out, but the code computes `100 + (−20) = 80 ≠ 70` → `mismatch`.
- **Consequences:** A single `mismatch` makes `assessCompleteness` return `'contradicted'` (line 374), so `buildBankAnswer` takes the `incompleteNoTotal` refusal branch and **withholds a correct, verifiable total**. The user is told their statement can't be reconciled when it can — a false negative that erodes trust just as the §22-D1 honesty posture worries about false positives.
- **Recommended fix:** Accumulate amounts across gap rows: carry a `sinceLastPrinted` cents accumulator; on a balance-less row add its amount; on a balance-bearing row compare `toCents(prevBalance) + sinceLastPrinted + toCents(row.amount)` and reset the accumulator. Treat the chain as genuinely broken (revert to `unknown`) only when a row's **amount** itself is missing. No persisted figure changes (don't bump `BANK_EXTRACTOR_VERSION`), but the `reconciled` flag / row statuses change, so re-validate on read.
- **Testing needed:** Characterization-first. A statement with a balance-less amount row between two balance-bearing rows whose true chain ties out → all `ok`/`unknown`, `reconciled:true`, `assessCompleteness==='complete'`; a genuinely-broken chain → `mismatch`. Drive the real `reconcileBalances`/`extractTransactionRows` with whole-string fixtures (TEST-N2 discipline).
- **Docs:** known-limitations LINE PARSER + arch §8 (a reconcile-gap note).

#### C2 — three citation-snippet builders slice by UTF-16 code unit (the RAG-2 surrogate-split bug, off the main RAG path)
- **Category:** Correctness (display) · **Severity:** Low · **Confidence:** High
- **Location:** `skills/analysis/bank-statement.ts:222`, `skills/analysis/invoice.ts:149`, `analysis/coverage.ts:114`
- **Description:** RAG-2 fixed surrogate-pair splitting in `rag/index.ts` via `truncateSnippet` (code-point slicing). Three other citation builders still do `c.text.slice(0, 280)` on raw UTF-16, which can cut inside a surrogate pair and leave a lone surrogate (`�`).
- **Evidence:** `snippet: c.text.length > 280 ? \`${c.text.slice(0, 280)}…\` : c.text` (identical in all three).
- **Consequences:** Cosmetic `�` in persisted bank/invoice/tree-leaf citation snippets — the exact symptom RAG-2 eliminated, on the skill/analysis provenance paths.
- **Recommended fix:** Route all three through the exported `truncateSnippet` (or a shared 280-cap variant); one shared function stops the divergence recurring.
- **Testing needed:** A chunk whose 280th UTF-16 unit lands mid-surrogate → snippet is valid UTF-8, no lone surrogate.

#### C3 — `documentLeafProvenance` emits non-contiguous `[Sn]` labels when a leaf-chunk row is missing
- **Category:** Correctness (latent) · **Severity:** Low · **Confidence:** High
- **Location:** `analysis/coverage.ts:106-116`
- **Description:** Labels come from the loop index over the full `ids` list, but a missing row is skipped *after* the index advances, yielding `S1, S3, S5…`. (Contrast `buildBankCitations`, which maps over the already-filtered array and is gap-free.)
- **Evidence:** `ids.forEach((id, i) => { const r = byId.get(id); if (!r) return; out.push({ label: \`S${i+1}\`, ... }) })`
- **Consequences:** Whole-document answers aren't inline-`[Sn]`-cited today (FE-B), so impact is small, but any future consumer assuming contiguous labels mis-resolves. Latent landmine.
- **Recommended fix:** Filter to resolved rows first, then assign `S${i+1}` over the filtered array.
- **Testing needed:** A reachable leaf id with no matching `chunks` row → labels contiguous from S1.

#### C4 — `aggregateExtractions` item `count` is record-count, not distinct-section count (can exceed the section count)
- **Category:** Correctness (honesty) · **Severity:** Low · **Confidence:** High
- **Location:** `analysis/extract.ts:307-319`
- **Description:** `COUNT(*)` counts every `extraction_records` row for a normalized value while `sourceChunkIds` is `new Set`-deduped. If the model emits the same item twice within one chunk, `count` overstates occurrences relative to the cited sections.
- **Evidence:** insert: `for (const item of items) insertRow.run(...)` (no per-chunk dedup); aggregate: `COUNT(*) AS cnt` vs `GROUP_CONCAT(chunk_id)` → `new Set`.
- **Consequences:** "Party X — appears 5 times (Page 2, Page 7)" where the real distinct-section count is 2. A concrete count↔provenance mismatch.
- **Recommended fix:** Report `count` as `COUNT(DISTINCT chunk_id)`, or dedup items per chunk before insert. (See P3 — the same query has a scale problem.)
- **Testing needed:** A chunk whose model reply repeats a value → `count` matches distinct source sections.

#### C5 ✅ — zero-amount row classified inconsistently between `summarizeCashflow` and `categorizeRow`
- **Category:** Correctness (presentation) · **Severity:** Low · **Confidence:** Medium
- **Location:** `skills/tools/bank-statement.ts:766` (summary, `amount >= 0` → inflow) vs `:698` (categorize, `amount > 0` Income / `< 0` Spending / else Uncategorized)
- **Description:** A genuine `0.00` row is "inflow" for the summary but "Uncategorized" for the breakdown — the two surfaces disagree for the same row. Totals stay correct (the figure is zero); only attribution diverges.
- **Recommended fix:** Pick one convention for zero (e.g. neither inflow nor outflow) and apply in both.
- **Testing needed:** A `0.00` row → consistent treatment across summary and breakdown.
- **✅ Phase A (2026-06-30):** picked **zero is neither inflow nor outflow** (the recommended convention). `summarizeCashflow`'s loop is now `amount > 0` → `totalIn` / `amount < 0` → `totalOut` (a `0.00` row falls into neither), matching `categorizeRow`'s existing `Uncategorized` fallback for zero; a clarifying comment was added to both so the shared convention can't drift. **Note (transparent):** because the figure is zero, the change is **NOT output-observable** in `summarizeCashflow` (adding `0` to `totalIn` is a no-op), so the test pins the *convention* and guards regression rather than going RED before the fix — `categorizeRow(0) === Uncategorized` + `summarizeCashflow` excluding the zero from both totals (1 test in `skills-bank-statement-tool.test.ts`).

### Security / data handling

#### S1 — document titles/filenames are written to the persisted audit log, then exfiltrated by the plaintext `activity-log.json` export (policy inconsistency)
- **Category:** Data handling / privacy consistency · **Severity:** Low-Medium · **Confidence:** High (behavior) / the *severity* is a product call
- **Location:** `registerDocsIpc.ts:388` (`document_imported`), `:654` (`document_reindexed`), `doctasks/handlers/shared.ts:131`; amplifier `registerAuditIpc.ts:37-50` (`exportAuditLog` → `JSON.stringify(events)` → user-chosen plaintext file).
- **Description:** The import audit message interpolates `info.title` (= `displayTitle ?? basename(filePath)`). `audit.ts:15` *documents* filenames as allowed metadata — so this is **deliberate, not an accidental leak** — but it is **inconsistent** with the chat channel (`registerChatIpc.ts:349` audits `conversationId` only "because the title is content") and the collections channel (`registerCollectionsIpc.ts:22` refuses to audit a project name as "content-ish"). The imported document's real filename is arguably *more* sensitive than a conversation title, and `exportAuditLog` writes it as plaintext outside the vault.
- **Evidence:** `ctx.audit?.('document_imported', \`Document imported: ${info.title}\`, …)`; `audit.ts:16` "carry ids, model ids, filenames, and counts"; `tests/integration/audit-ipc.test.ts:273` blesses "the FILENAME is fair game."
- **Consequences:** A user who exports their activity log (intended for support) leaks every imported filename — e.g. `biopsy-results.pdf`, `divorce-settlement.pdf` — the kind of metadata the vault exists to protect.
- **Recommended fix:** **Decide the policy explicitly** (this is the real deliverable). Either (a) align import to the chat/collection bar — drop the title from the message, audit `documentId`+`status`+`chunkCount` only — or (b) accept it and document the divergence in `security-model.md` *and* note the export carries filenames. Given two sibling channels already treat user-chosen names as content-to-protect, (a) is the consistent choice.
- **Testing needed:** Extend the audit privacy sentinel to assert no document title/basename appears in any `runtime_events.message`/`metadata_json` after import + re-index + doc-task materialize, and over the `exportAuditLog` payload.

#### S2 — the skill drop-in / per-turn read path bypasses the installer's size caps (unbounded `readFileSync` + `JSON.parse`)
- **Category:** Resource exhaustion · **Severity:** Low · **Confidence:** High
- **Location:** `skills/manifest.ts:33` (and the sibling `manifest.json` `JSON.parse`), reached by `discoverSkillsInDir` (`registry.ts:163`) and `loadSkillPackage` (`loader.ts:71,82`).
- **Description:** All skill caps (`maxFileBytes` 1 MiB, `maxTotalBytes` 8 MiB, `maxBodyChars` 64 KiB) are enforced only inside the installer's `stageZip`/`stageFolder`. The single on-disk read point reads `SKILL.md`/`manifest.json` with a bare `readFileSync(...,'utf8')` and no `statSync` guard; `maxBodyChars` is applied only after the whole file is read, and never to the frontmatter.
- **Consequences:** A folder dropped into the unencrypted `user-skills/` with a huge `SKILL.md`/`manifest.json` is read wholesale into main-process memory (and JSON-parsed) on every reconcile / per chat turn — a local memory-exhaustion DoS. Bounded (requires local FS write; install-disabled until enabled), hence Low.
- **Recommended fix:** Add a `statSync(path).size > limits.maxFileBytes` pre-check in `parseSkillManifestFromDir` before each read, mirroring `stageFolder`.
- **Testing needed:** A drop-in folder with an over-cap `SKILL.md` (and separately `manifest.json`) is skipped/rejected without a full read.

#### S3 — `transcribeDictation` is not lock-gated; writes a transient plaintext WAV into the workspace documents dir while the vault is locked
- **Category:** Lock-guard parity / data-at-rest · **Severity:** Low · **Confidence:** High
- **Location:** `registerDictationIpc.ts:71-92` (no `requireUnlocked()`; `tempPath = join(storeDir, …)` then `await writeFile(tempPath, audio)`).
- **Description:** Unlike every other workspace-touching handler, dictation dispatches purely on `ctx.transcriber` presence, never `isUnlocked()`. On a locked encrypted workspace it lands plaintext audio in the documents dir (which should hold only `.enc` sidecars while locked). The temp is shredded in `finally` and swept on next startup, so nothing is *retained* — the residual is a brief plaintext window plus an inconsistency with the F16 lock-guard parity invariant.
- **Recommended fix:** Add `requireUnlocked()` at the top of the handler.
- **Testing needed:** `transcribeDictation` rejects when locked; no file written under `workspace/documents/` in that case.

#### S4 — (confirmation, not new) unsigned user-writable manifests can redirect a download to an arbitrary public host
- **Category:** Trust model · **Severity:** Low→Medium · **Confidence:** High (gap) / Low (exploitability)
- **Location:** `assets.ts:482-495` (`assertSafeDownloadUrl` — scheme + private-range deny-list, no host allowlist); `shared/manifest.ts:132-196` (no signature/pin); `model-manifests/` user-writable.
- **Description:** The SSRF hardening is solid (HTTPS-only, redirect-revalidated, private/loopback/metadata denied incl. mapped-IPv6 F15), but there's no positive host allowlist and manifests are neither signed nor pinned. A local adversary editing a manifest can point a download at any public HTTPS host; hash verification doesn't help (the attacker controls both URL and declared `sha256`). This is the already-recorded **§22-M2 "trust by location, not signature"** residual — flagged here only to confirm it remains the accepted posture and to note a cheap incremental hardening (a download-host allowlist).
- **Recommended fix:** Product decision (manifest signing/pinning) or a host allowlist. Otherwise re-affirm as accepted.

### Reliability / error handling

#### R1 — lock path can persist a chat partial against a closing/locked DB (lost reply or unhandled rejection)
- **Category:** Reliability (race) · **Severity:** Medium · **Confidence:** Medium-High
- **Location:** `registerWorkspaceIpc.ts:217-263` (lock handler) × `chat.ts:1166-1188` (`generateAssistantMessage`) × `ipc/chat-stream.ts`.
- **Description:** `lockWorkspace` aborts in-flight streams synchronously, then `await Promise.allSettled([runtime.stop(), …])`, then `purgeResidentVectors` + `lock()`. The partial-reply persistence on abort happens in the chat IPC's *own* promise (the `for await` unwinds → `appendMessage`), which the lock sequence **never awaits** — `inFlightStreams` holds only `AbortController`s, not completion promises. The comment ("their partial replies persist while the DB is still open") relies on `runtime.stop()` outrunning the abort-unwind. For an already-exited or mock sidecar, `stop()` can resolve in a microtask and `lock()` can close/zero the DB **before** `appendMessage` runs.
- **Consequences:** (a) the user's partial reply is silently dropped (the REL-4 data-loss class, on the lock path); or (b) `appendMessage` runs against a locked DB → `requireDb()` throws → an **unhandled rejection** only `log.warn`'d by the global handler.
- **Recommended fix:** Make persistence deterministic: register a per-stream "settled" promise alongside the controller in `inFlightStreams`; in `lockWorkspace`, after aborting and before `purgeResidentVectors`/`lock()`, `await Promise.allSettled([...settled])`. At minimum, guard `appendMessage` so a locked DB during partial-persist is swallowed cleanly. Apply the same to the quit path (`shutdown.ts`) for symmetry.
- **Testing needed:** Fake runtime whose `stop()` resolves immediately while a chat stream's abort-unwind is pending; assert the partial persists before lock and no rejection escapes.

#### R2 — arbiter `acquireForChat` fast path takes a holder without an abort listener → holder-accounting drift / build-resume stall
- **Category:** Concurrency (latent) · **Severity:** Medium · **Confidence:** Medium
- **Location:** `analysis/model-slot-arbiter.ts:113-135`
- **Description:** When a yielding build is already parked (`reacquireReject !== null`), `acquireForChat` increments `chatHolders` and takes the fast path that skips `waitForHandoff` — and therefore installs **no abort listener**. The common case is safe (`withChatStream`'s `finally` calls the release fn). But the slow-path `onAbort` only drops `pauseRequested`/resumes when it's the *last* waiter; with one fast-path holder + one parked (slow-path) chat, aborting the parked chat can leave `pauseRequested`/`handoffWaiters`/`chatHolders` transiently disagreeing, and the build resumes only when the *other* chat releases — a temporary stall (not a permanent deadlock, given the guaranteed `finally` release).
- **Recommended fix:** Install the abort cleanup on **both** paths (attach a `once:'abort'` listener that calls `releaseOneChat()` and resumes if last), or fold the fast-path holder accounting into one helper so abort handling can't diverge by path.
- **Testing needed:** Two concurrent `acquireForChat` (one parked, one fast-path) with the parked one aborted; assert `chatHolders` returns consistent and the build resumes once the survivor releases.

#### R3 — `getResidentVectors` reconcile mutates the live cache map in place before clearing `pending` (half-mutated map observable on throw)
- **Category:** Reliability (latent) · **Severity:** Medium · **Confidence:** Medium
- **Location:** `embeddings/resident-cache.ts:253-283`
- **Description:** `reconcileDelta`/`reconcileFull` mutate `cached.byChunk` in place via synchronous SQLite reads, then set `cached.signature`/`cached.pending = null`. If a read throws mid-reconcile, the map is left partially mutated with `pending` not cleared and `signature` not updated; the throwing window exposes a map that is neither the old nor the new consistent state to a concurrent `VectorIndex.search`. The delta/full paths are idempotent so it self-heals on the next clean query, but the in-place-before-commit ordering is the only spot where a throw leaves observable mixed state.
- **Consequences:** A search overlapping a transient DB read error can rank against a few missing/extra vectors — a silent ranking anomaly until self-heal. Latent; backstops exist.
- **Recommended fix:** Reconcile into a scratch map (or snapshot) and commit (`byChunk`, `signature`, `pending=null`) only after full success; on throw leave the prior committed map intact.
- **Testing needed:** Inject a `db.prepare` that throws on the second point-lookup during `reconcileDelta`; assert the next successful query equals a from-scratch build and no query observes a partial map.

#### R4–R7 — low-severity latent teardown/lifecycle hazards
- **R4 (Low, latent)** `ocr/pipeline.ts:24-41` — the catch `await`s the **same** already-settled `prevOnPage` again for the final page; harmless today, but the "drain the in-flight recognition" guarantee is wrong for the last page. Fix: null `prevOnPage` before the in-try final `await`.
- **R5 (Low, latent)** `runtime/gpu.ts:141-160` — probe timeout `SIGKILL`s but doesn't await reap; rapid `invalidate()`+re-probe ("Try GPU again" mashing) stacks short-lived children (unref'd, OS-reaped). Fix: ignore/await an in-flight probe per binary before starting a new one.
- **R6 (Low, latent)** `ocr/rasterizer.ts:100-107` — `expect(channel)` overwrites a pending `waiter` without rejecting it; safe under the current single-in-flight protocol, but a duplicate frame / refactor would orphan the prior promise to its 60 s timeout. Fix: reject the existing waiter before reassigning.
- **R7 (Low, latent)** `vision/runtime.ts:194-309` — `analyze()`'s `finally` `armIdleTimer()` vs a concurrent `stop()` is unsynchronized across the await; a timer armed in the window survives `stop()`'s `cancelIdleTimer()` (unref'd, self-cancels on fire). Fix: re-call `cancelIdleTimer()` after the awaits in `stop()`.

### Frontend / renderer

#### F1 — `DictationButton.stopAndTranscribe()` does setState / fires `onText` after unmount (and can cross conversations)
- **Category:** Renderer lifecycle · **Severity:** Medium · **Confidence:** High
- **Location:** `renderer/chat/DictationButton.tsx:99-118`
- **Description:** The `start()` path is `mountedRef`-guarded (F21), but `stopAndTranscribe()` awaits the multi-second `transcribeDictation` IPC and then unconditionally calls `onText(text)`/`onError(...)` and `setState('idle')` in `finally` with **no `mountedRef` check**. The unmount cleanup only `cancel()`s an active recording, but by then `captureRef.current` is nulled and `stop()` already called.
- **Consequences:** Stop-dictation then navigate away → setState-on-unmounted warning, and `onText` fires the parent's `setInput` after the screen unmounted; stale dictation text can land in a different conversation's composer (the parent's `mountedRef` doesn't gate `setInput`).
- **Recommended fix:** Add the `mountedRef` guard before `onText`/`onError` and the `finally` `setState`, mirroring `start()`.
- **Testing needed:** Start+stop recording, resolve `transcribeDictation` *after* `unmount()`; assert `onText` not called, no act-warning (mirror the F21 test at `Dictation.test.tsx:264`).

#### F2 — `Transcript` runs `localizeServerCopy(t, streamText)` twice per ~40 ms flush on the growing buffer
- **Severity:** Low · **Confidence:** High · **Location:** `renderer/chat/Transcript.tsx:191,196`
- **Description:** The live bubble calls `localizeServerCopy` for the visible text and again for `<StreamAnnouncer>`, each an O(n) Map-lookup + two regex `.exec` + `includes` over the entire growing buffer, ~25×/sec, on the CPU-bound streaming path. Real model output never matches the localization table mid-stream, so it's near-pure overhead.
- **Recommended fix:** `const localized = useMemo(() => localizeServerCopy(t, streamText), [t, streamText])` and pass to both.

#### F3 — ChatScreen proactive skill-suggestion debounce fires `refreshSuggestion` without a mounted/cancel guard
- **Severity:** Low · **Confidence:** Medium · **Location:** `renderer/screens/ChatScreen.tsx:639-643,658-671`
- **Description:** The 400 ms timer calls `window.api.suggestSkills(...).then(setSkillSuggestion)`. Cleanup clears the timer, but a fired-and-in-flight IPC resolving after unmount / `activeId` change sets state on a dead/changed component (the file's own FE-1 `mountedRef` discipline isn't applied here). A late reply can stamp a stale-conversation suggestion.
- **Recommended fix:** Gate `setSkillSuggestion` behind `mountedRef.current` (and compare `convId`).

#### F4 — ImagesScreen "Try again" is silently dropped when any analysis is in flight
- **Severity:** Low-Medium · **Confidence:** Medium · **Location:** `renderer/screens/ImagesScreen.tsx:393`, `images/AnswerThread.tsx:98`, `lib/visionSession.ts:164`
- **Description:** `analyze()` early-returns on `snapshot.activeJobId` with no feedback, and the per-turn "Try again" button has no `disabled` while a *different* turn streams — so a click during the busy window is swallowed with no answer and no error.
- **Recommended fix:** Disable per-turn actions while `analyzing`, or surface `images.err.busy` when `analyze()` early-returns.

#### F5–F8 — low-severity renderer items
- **F5 (Low)** `Composer.tsx:75-81` — auto-grow effect reads `scrollHeight`/`offsetHeight` after writing `style.height`, forcing a layout reflow per keystroke (compounds with ChatScreen's per-keystroke re-render). Acceptable for one textarea; batch via rAF if it shows.
- **F6 (Low, a11y)** `Transcript.tsx:377-426` (`StreamAnnouncer`) — only advances on sentence terminators and `stripMarkdown`s code/markup to spaces, so a code-block- or table-only answer announces nothing until completion (then near-empty). Document as an accepted limitation or add a length-based fallback boundary.
- **F7 (Low)** `ChatScreen.tsx:915-939` — regenerate optimistically slices the last assistant turn before `stream(...)`; if the IPC throws *before* the backend mutates, or the user switched conversations, the local view drops an answer the DB still holds until a manual re-select. Self-heals; not data loss.
- **F8 (Low, hypothesis)** `lib/visionSession.ts:202-232` — `unsubs`/`activeTurnId` are module-global; a fast image-switch-then-analyze can let a prior job's `teardownStream()` clear the new job's `unsubs`. Hard to hit (busy guard). Fix: scope per-job and verify `job.jobId === activeJobId` before patching.

### Performance / scalability

#### P1 ✅ — mode-(b) compare does O(N_A × N_B × dim) cosine + per-A-chunk sort synchronously on the main thread, with the slow `cosineSimilarity`
- **Category:** Performance · **Severity:** High @ scale · **Confidence:** High
- **Location:** `doctasks/handlers/compare.ts:218-241`
- **Description:** `nearestB(vec)` scans *all* doc-B vectors with `cosineSimilarity` (the 3-accumulator variant) and re-sorts N_B hits to keep top-3, once per doc-A chunk across all windows. The comment claims "same ranking VectorIndex.search produced" but doesn't use the `dotProduct` fast path `VectorIndex` uses on already-L2-normalized stored vectors.
- **Evidence:**
  ```ts
  for (const b of bChunks) { ...; hits.push({ chunkId: b.id, score: cosineSimilarity(vec, b.vec) }) }
  hits.sort((x, y) => y.score - x.score)   // O(N_B log N_B) PER A-chunk
  ```
- **Consequences (scale):** two ~1000-chunk docs ≈ ~1,000,000 cosine evals × 384 dims ≈ ~0.77 billion FLOPs + 1000 sorts of 1000 — a multi-second main-thread freeze that also stalls `node:sqlite`, IPC, and the import loop. Degrades quadratically; fine at a few-hundred chunks each.
- **Recommended fix:** (a) use `dotProduct` (identical ranking on normalized vectors, ~2× fewer FLOPs); (b) replace the per-call `sort` with a running top-K selection (drops the `N_A·N_B·log N_B` term); (c) longer-term, the deferred P4b worker.
- **Validate:** bench `runCompare` on two synthetic 1000-chunk docs; main-thread block < ~250 ms; ranking-equivalence test (cosine vs dot top-3).
- **✅ Phase B (BEHAVIOR-PRESERVING):** the inline `nearestB` is now the pure, exported `compareNearestNeighbors` (`doctasks/compare.ts` — pure math beside the other compare helpers, per D4) using **`dotProduct`** + a **running top-K** (descending score, ties broken by doc-B insertion = `chunk_index` order). **Equivalence is proven in two exact links** (`tests/unit/compare-nearest-neighbors.test.ts`): (A) the running top-K is *byte-identical* to a stable descending dot-sort + slice (no float luck — same scores, just the selection algorithm); (B) on L2-normalized vectors a dot-sort-slice selects the *same ids* as the old cosine-sort-slice (the RAG-1 invariant: cosine == dot for unit vectors — VERIFIED at the source: every stored chunk vector is normalized by `e5.ts l2normalize` / the mock embedder, and the codec is an exact float32 round-trip). Chained, new == old. **Teeth-checked:** flipping the running-K tie-break (`<` → `<=`) reds the stable-tie test; restored. The handler comment's false "same ranking VectorIndex.search produced" claim is corrected. **Micro-bench** (`tests/manual/phaseB-perf-bench.test.ts`, CI-gated `RUN_PHASEB_BENCH=1`): two synthetic 1000×1000 docs — old cosine+sort **1253 ms** → new dot+top-K **571 ms** main-thread block (**2.2×**, matching the predicted ~2× FLOPs). The absolute "<250 ms" target is hardware-specific (this dev box; the bench asserts the machine-independent `new < old` and logs the absolute against the ~250 ms reference). Mode-(c) `alignNodes` (node-vector cosine) is OUT of P1 scope and untouched.

#### P2 ✅ — `VectorIndex.search` marshals every in-scope `chunk_id` row + runs the dot-product loop synchronously per query
- **Category:** Performance · **Severity:** Medium @ scale · **Confidence:** High
- **Location:** `embeddings/index.ts:203-233`
- **Description:** PERF-1/F12 removed the per-query BLOB read + decode (excellent), but the query still does `SELECT chunk_id FROM embeddings WHERE <model+scope>` and materializes **one JS row object per in-scope chunk**, then a synchronous `dotProduct` over all of them + a full sort — on the main thread, on every question (and again for the re-index-honesty re-check). For the default whole-Library scope the resident map already *is* the candidate set.
- **Consequences (scale):** at 100k chunks, ~100k transient row objects + a 100k × 384 multiply-add (~38M FLOPs) + 100k-element sort per query, blocking SQLite/IPC. ~tens of ms of pure JS + GC churn.
- **Recommended fix:** when no document/collection scope filter is present, iterate `resident` directly (filtered by model id) and skip the `SELECT chunk_id` entirely; fall to the SQL candidate scan only with a real scope filter. Removes the per-query 100k-row marshal without the P4b worker. (Companion: P6 — `computeSignature`'s `COUNT(*)` becomes the next bottleneck once this lands.)
- **Validate:** micro-bench at 10k/50k/100k resident vectors with/without the scan-skip; assert identical top-k.
- **✅ Phase B (BEHAVIOR-PRESERVING):** `search` now splits into `collectResidentHits` (the fast path) and `collectScopedHits` (the **unchanged** scoped SQL scan), sharing the determinism sort. The fast path iterates the resident map directly and skips the `SELECT chunk_id` marshal. **The candidate-set equivalence has two real subtleties handled exactly:** (1) **model-id filter** — the resident map holds chunks under *all* model ids (a transient mock→real migration mix), so the cache now also keeps `modelByChunk` (chunkId → `embedding_model_id`, same key set as `byChunk`, maintained in `build`/both reconcile paths) and the fast path replicates `WHERE embedding_model_id = ?` in memory; (2) **archived exclusion** — archiving KEEPS embeddings, so archived chunks are resident, and the default scope excludes them. The gate `canIterateResident()` therefore takes the fast path ONLY when there is no document/collection union AND (`includeArchived` OR no archived docs exist — a cheap `documents`-table existence probe); otherwise the scoped scan runs UNCHANGED (its `buildScopeFilter` archived/scope predicate intact). **Equivalence test** (`tests/integration/vector-search-resident-iteration.test.ts`): an unscoped search == an all-documents *scoped* search hit-for-hit (ids + scores) — driving BOTH real paths over the same universe — plus the half-migrated model mix, null-model-id, and both archived branches; a `db.prepare` spy confirms the fast path issues NO `SELECT chunk_id FROM embeddings` and the scoped path still does. The existing `embedding-mismatch.test.ts` (model-filter) + `embeddings.test.ts` (23 cases) pass byte-identical. **Teeth-checked:** dropping the in-memory model filter reds the half-migrated test; restored. **Micro-bench** (CI-gated): unscoped fast path vs all-docs scoped scan — N=10k **56→10 ms/query (5.5×)**, N=50k **304→61 ms/query (5.0×)** — confirming the marshal was the cost. The scope-FILTERED path is byte-unchanged. (No schema/IPC/audit-payload change; `modelByChunk` shares the existing vector `Float32Array` refs.)

#### P3 — `aggregateExtractions` GROUP_CONCATs all chunk_ids into one string, then `split(',') + new Set` per group
- **Category:** Performance / scalability · **Severity:** Medium @ corpus scale · **Confidence:** High · **Location:** `analysis/extract.ts:307-320`
- **Description:** `extraction_records` is the one analysis table not bounded by the per-document 1000-chunk cap — it grows with `documents × chunks × items/chunk`. A recurring `normalized_value` (a common date/amount, or the `__scan__='ok'` markers) aggregates tens of thousands of 36-char UUIDs into a single multi-MB string, then `split(',')`'d and `new Set`-deduped on the main thread at "list every date/amount" time. Indexes make the scan cheap but don't help the GROUP_CONCAT materialization + JS re-parse.
- **Recommended fix:** `GROUP_CONCAT(DISTINCT chunk_id)` (dedup in SQL) and cap per-group provenance (LIMIT-bounded subquery, or lazy-fetch source ids only when an item is expanded). Also fixes C4's count↔provenance mismatch.
- **Validate:** seed a value repeated across ~20k chunks; measure the listing query + JS post-processing.

#### P4 — `listMessages` returns the whole conversation (full content + parsed citations) over IPC on every open AND after every turn
- **Category:** Performance / scalability · **Severity:** Medium @ long chats · **Confidence:** High · **Location:** `chat.ts:424-433`, `renderer/screens/ChatScreen.tsx:846`
- **Description:** Distinct from the accepted "renderer transcript windowing deferred" residual (that's DOM nodes). Here the *backend query + IPC payload + per-row `JSON.parse(citations_json)`* re-marshals the entire history (no LIMIT) on each conversation open **and after every completed turn** (`refreshIfVisible`). Cost grows O(turns), paid every turn.
- **Recommended fix:** Append only new rows after a turn (a `listMessagesSince(rowid)` IPC) and/or paginate the initial open (load the tail; lazy-load older on scroll). The compaction checkpoint is a natural cut point.
- **Validate:** measure `listMessages` + IPC at 100/500/1000 turns; confirm per-turn refresh drops to O(new rows).

#### P5–P6 — low-severity perf companions
- **P5 (Low)** `doctasks/manager.ts:169-176` — `maybeEnqueueTreeBuild` loads up to 1000 chunks of text and token-counts the lot on every ingest completion, purely to decide whether to enqueue a tree build (overhead for the common small-doc skip). Fix: gate cheaply on the persisted Σ `token_count` first; load text only if borderline. *(Not in Phase B scope — still open.)*
- **P6 (Low) ⏸ DEFERRED (Phase B — investigated, NOT applied; the per-search `COUNT(*)` is load-bearing).** `embeddings/resident-cache.ts:132-138` — `computeSignature` runs `COUNT(*) + MAX(rowid)` on `embeddings` on every search as the staleness backstop. Negligible vs the scan today, but becomes a meaningful fraction once P2 lands. Fix: only run the `COUNT(*)` backstop when `pending == null`, or maintain a cached count via the existing write hooks.
  - **⏸ Phase B finding (a related perf finding surfaced while verifying — recorded, not expanded into a risky change, per §4):** BOTH suggested fixes conflict with a **tested** staleness guarantee, so P6 cannot be safely remediated under the Phase-B constraints (keep the guarantee intact; no schema change). The clean (no-pending) path must still detect an **out-of-band DELETE of a NON-max-rowid row** — `resident-cache.test.ts` "reflects a direct DELETE after the cache was built" deletes the *first* (lowest-rowid) of three chunks via raw SQL and asserts the next search drops it. Such a delete leaves `MAX(rowid)` **unchanged**, so a `MAX(rowid)`-only backstop (suggestion #1, taken literally) silently serves the deleted row — VERIFIED: implementing it reds that test (and the symmetric one in `resident-cache-incremental.test.ts`). A maintained in-band count (suggestion #2) tracks only in-band writes, so it cannot see the out-of-band delete either; and gating `COUNT` behind a `MAX(rowid)` pre-check would run *two* queries on the unchanged hot path (slower), without removing the `COUNT` the case that matters needs. A safe O(1) count that survives out-of-band writes requires a DB-side counter (a `CREATE TRIGGER` = a schema change, explicitly out of scope). The per-search `COUNT(*)` is therefore RETAINED; the conflict is documented at the `getResidentVectorIndex` docstring + the module-header STALENESS bullet. Note P6 only ever bit *after* P2 (its premise), and P2's fast path still pays a single combined `SELECT COUNT(*), MAX(rowid)` (one cheap btree count) — far below the marshal P2 removed. **Suggested follow-up (separate, schema-touching):** an `AFTER INSERT/DELETE` trigger maintaining an `embeddings` row-count, making the backstop O(1) and unlocking the `COUNT`-free clean path — track alongside the other deferred items.

### Maintainability

#### M1 ✅ — duplicated comment block in `VectorIndex.search`
- **Severity:** Low · **Location:** `embeddings/index.ts:222-231` — the RAG-1 determinism comment (lines 222-226) is pasted verbatim again at 227-231. Harmless, but a copy-paste artifact. Delete the duplicate.
- **✅ Phase G (the one src/ touch — comment-only, behavior-preserving):** the verbatim second copy deleted; the single comment + the `hits.sort(...)` line are unchanged. Typecheck + the full suite (2593/39) identical green.

---

## 3. Documentation audit

The doc set is in very good shape; the model catalog (README ↔ manifests ↔ `recommendModelIdByRam`), the RAG defaults (chunk 500/overlap 80, topK 12/6, RRF_K 60, E5 384-dim), the security model (AES-256-GCM/Argon2id params, binary re-hash-before-spawn, skill tool ceiling), the storage stack (`node:sqlite`/Electron 37/Node 22), and a dozen constants/timeouts were spot-checked against code and **match**. The new findings almost all stem from one root cause: **the Phase-8 DX-1/DX-3 refactors (commit `1a8b78a`) relocated code, but the as-built topic-doc sections and code-comment maps were not updated** (the §38 ledger recorded the move; the sections a future agent reads first drifted).

| ID | Sev | Doc location | Contradicts (code) | Issue |
|---|---|---|---|---|
| **D1** ✅ | High | `architecture.md:1178-1180` ("Document tasks" module map) | `doctasks/` now has `manager.ts`+`context.ts`+`handlers/*` keyed by `MODEL_TASK_HANDLERS` | Describes the pre-DX-1 layout; never mentions `handlers/`, `context.ts`, the dispatch table. The as-built source of truth for the task engine is stale. **✅ Phase G:** section rewritten to the manager-keeps-the-pump / handlers-own-each-kind split + `DocTaskCtx` injection + the `handlers/` file list; cross-refs §38 DX-1. |
| **D2** ✅ | Med | `architecture.md:1184` ("Six `DocTaskKind`s") | `shared/types.ts:767` has **seven** (adds `categorize`) | Undercounts; `categorize` (D26 categorizer) is a manager kind, documented elsewhere in the same doc. **✅ Phase G:** "Six"→"Seven", `categorize` added to the enumeration. |
| **D3** ✅ | Med | `architecture.md:649` (ING-6), `:657` (ING-8) cite `doctasks/manager.ts` | `materializeDocument` → `handlers/shared.ts:84`; `readStoredPdfBytes` → `handlers/ocr.ts:104` | Symbols not in `manager.ts` anymore. **✅ Phase G:** ING-6 → `handlers/shared.ts`, ING-8 → `handlers/ocr.ts` (ING-7's manager.ts per-doc-reads citation left — still accurate). |
| **D4** ✅ | Med | `architecture.md:149,440` + `rag-design.md:1230` cite `manager.ts` for compare | run path is `handlers/compare.ts` (`runCompareSymmetricTrees`); pure math in `doctasks/compare.ts` | Two docs send readers to the wrong file for compare internals. **✅ Phase G:** all three repointed to `handlers/compare.ts`; **extended** to a 4th same-class citation the audit's line-list missed — `rag-design.md:912` (compare-path decodes). See discovered-items note below. |
| **D5** ✅ | Med | `services/doctasks.ts:1-17` (barrel header comment) | directory now has `handlers/`+`context.ts` | Barrel comment + `export *` list the pre-DX-1 four modules only. **✅ Phase G:** header comment rewritten (handlers/ + context.ts). Verified against the doctasks tests: NO handler run-fn is imported through the barrel (tests use `DocTaskManager`, the friendly-error constants — still in `manager.ts` — and the window-math fns), so the public surface is genuinely preserved; the `export *` list is unchanged (adding `context`/`handlers` would collide on `DocTaskDeps`). |
| **D6** ✅ | Med | `user-guide.md:329,457` ("Add to project…") | `documents/DocRow.tsx:336` renders `docs.action.moveToProject` = "Move to project…" | UI label mismatch; the `addToProject` key exists but is unused by the row menu/toolbar. **✅ Phase G:** all 4 occurrences relabeled "Move to project…". |
| **D7** ✅ | Low | `user-guide.md:330-331` (selection toolbar actions) | `DocumentsScreen.tsx:849-897` also renders "Mark temporary" + "Archive" | Action list incomplete. **✅ Phase G:** "Mark temporary" + "Archive" added in toolbar order. |
| **D8** ✅ | Low | `architecture.md` §36 PERF-2 / known-limitations windowing note | DX-3 split `DocumentsScreen.tsx` → `screens/documents/*` | Behavior accurate; implied single-file location stale. **✅ Phase G:** one-line DX-3 location note added to §36 (the known-limitations entry names no file, so it needed no change). |
| **D9** ✅ | Low | `CHANGELOG.md:10-12`, `package.json` `0.1.34` | BUILD_STATE shows work through 2026-06-30 | Version stopped tracking the per-phase ritual (version hygiene). **✅ Phase G (lighter-touch, flagged):** CHANGELOG note added — version checkpointing paused after `v0.1.34`; later phases tracked in BUILD_STATE.md. `package.json` deliberately NOT bumped (owner's call for the first real release). |
| **D10** ✅ | Low | `README.md:206-207` (drops "(F16)" quant qualifier); `security-model.md:832` (`MONEY_RE` snippet omits the `'` member) | manifests carry the qualifier; `money.ts:81` has the apostrophe member | Cosmetic; asserted properties still correct. **✅ Phase G:** README E5/reranker → "(F16)"; security-model snippet → `[\d.,']`. |

**Highest-leverage fix:** update the architecture.md "Document tasks" section (§1177-1190) and the `doctasks.ts` barrel comment to the post-DX-1 `handlers/` layout — that resolves D1–D5 at their shared root.

---

## 4. Testing audit

**Strengths (verified):** crypto round-trips + AEAD tamper/truncation, vault password-change/v1→v2 migration crash-recovery (journaled, cut at every step, secret-never-on-disk scan), `ModelSlotArbiter` concurrency matrix on deterministic ticks, `combineSignals` fake-timer lifecycle, the `deleteConversation` mid-transaction rollback + connection-not-poisoned check, skill/doctask cancellation asserting observable effects, and the adversarial financial whole-string suite (`skills-bank-statement-tool.test.ts`). This is a genuinely strong suite.

**Weaknesses / gaps (new):**

| ID | Sev | Where | Issue / what could slip through |
|---|---|---|---|
| **T1** | Med | `tests/integration/vision-teardown.test.ts:37,66,72,103,108`, `vision-cancel.test.ts:61` | Real `setTimeout` `sleep(N)` gates the REL-2 interleave premise (`void this.run` is detached; nothing deterministically guarantees it parked in `getStatus()` before `stop()`). Under CPU starvation the assertion `createCalls===0` can pass **vacuously** — a regression removing the post-`getStatus()` `tearingDown` re-check could ship green. Ironically the Phase-7 TEST-1 round deleted exactly this real-timer class from a *sibling* file. Fix: deterministic park gate (the `model-slot-arbiter`/`combine-signals` pattern). |
| **T2** | Med | `tests/renderer/DocumentsScreen.test.tsx:~1039-1094` | Render-count deltas on the private `__docRowRenderCounts` Map are the **sole** oracle — no `toBeChecked()`, no selection-UI assertion. A regression where the click stops toggling selection but an unrelated re-render still bumps the count passes green; and since DX-2 DEV-guards the counter, the test degenerates if DEV ever flips. Fix: pair each delta with a behavioral assertion. |
| **T3** | Med | rollback paths: `tree-build.ts:255`, `ingestion/index.ts:750/944/1549`, `doctasks/handlers/categorize.ts:111`, `analysis/node-vectors.ts:156`, `vision/history.ts:233` | Only **1 of ~12** `BEGIN…COMMIT…ROLLBACK` sites (`deleteConversation`) has an injected-failure rollback test. The rest claim rollback-on-throw in comments but no test drives it; on the single shared `DatabaseSync` connection, a left-open `BEGIN` poisons the *next* unrelated op. The ingestion path (~1000 inserts) is higher-blast-radius than the one tested. Fix: add injected-failure tests for `commitNode` + the categorize persist, mirroring `data-layer-hardening.test.ts:67-100` (assert no partial rows + a subsequent `BEGIN/COMMIT` succeeds). |
| **T4** ✅ | Low-Med | no `tests/unit/money.test.ts` | `detectDocumentCurrency`/`inferDateOrder`/`csvField`/`wordIncludes`/`parseAmount`/`MONEY_RE` are exercised only via whole-string fixtures; specific regex/parser boundary cells (apostrophe+decimal, `csvField` formula-lead × quote × CRLF, `wordIncludes(compound)` repeated needle) are untested in isolation. A locale tweak could pass every integration fixture while breaking a cell. Add a pure-function table test (cheap, offline). **✅ Phase A (landed WITH the financial fix, per §7's note):** new `tests/unit/money.test.ts` — 42 pure-function table tests covering `parseAmount` (incl. the apostrophe+decimal `1'234.56` cell + the 2-dp integer-cent invariant), `MONEY_RE` token boundaries (apostrophe-decimal whole, bare-thousands, plain-integer reject, continuation anchor), `detectCurrency`/`detectDocumentCurrency` (figure-region exclusion + majority vote), `inferDateOrder`/`parseDate`/`splitLeadingDates`/`stripDateTokens`, `wordIncludes` (strict vs compound, repeated-needle scan), and `csvField` (formula-lead × quote × CRLF). Offline, no model/network. |
| **T5** | Low | `vitest.config.ts:36-41` | The 3× timeout (15 s) papers over documented "1-2 flakes per run, a different test each time" instead of removing the wall-clock waits. Treat the flakes as a backlog (start with T1). |
| **T6** | Low | `tests/integration/password-change.test.ts:388-399` | The doc-work/password-change race guard drives the private `changingPassword` field directly ("cannot be produced from the outside"), pinning implementation state, not the invariant. If `changePassword` becomes async and forgets to set the flag, the test still passes. At least spy the flag transitions; ideally inject a pause inside the real `changePassword`. |
| **T7** | Low | `assets.ts:451-475`, `tests/integration/assets.test.ts:701-792` | The SSRF guard is literal-dotted-decimal only; decimal/octal/hex IP encodings of loopback are neither blocked nor tested nor documented as out-of-scope. Either canonicalize numeric hosts + test, or assert `assertSafeDownloadUrl` rejects `http://2130706433/` so the decision is pinned. |

**Avoid over-mocking guidance:** the suite already mostly drives real entry points (the financial, crypto, arbiter, and rollback tests are exemplary). The two regressions to watch are (a) timing-dependent premises (T1/T5) and (b) private-state/implementation-detail oracles (T2/T6) — both pass vacuously when the real behavior breaks. New tests for the findings above should drive the real `reconcileBalances`/`VectorIndex.search`/transaction functions, not stubs.

---

## 5. Performance audit

See findings **P1–P6** (§2) for the detail. Summary of the scalability cliffs and where they bite:

- **P1 (High) ✅ — large-document compare** freezes the main thread for seconds at ~1000+ chunks/side (quadratic). Cheap fix: `dotProduct` + running top-K. **✅ Phase B (2.2× measured, equivalence-tested).**
- **P2 (Med) ✅ — per-query vector search** marshals 1 JS object per in-scope chunk even though the resident cache holds the vectors; bites at ~50k–100k chunks (~tens of ms + GC churn per question). Fix: iterate the resident map on the unfiltered scope. **✅ Phase B (5× measured; model + archived equivalence preserved).**
- **P3 (Med) — extraction listing** builds a multi-MB GROUP_CONCAT string + JS Set at large corpus; fix with `DISTINCT` in SQL + a provenance cap.
- **P4 (Med) — long chats** re-marshal the whole history over IPC every turn (O(turns)); fix with incremental append + initial-open pagination.
- **P5 (Low) / P6 (Low ⏸ deferred)** — eager tree-build gating reads all chunk text per ingest; `computeSignature` `COUNT(*)` per search (the next bottleneck after P2 — but **⏸ DEFERRED in Phase B**: the per-search `COUNT(*)` is load-bearing for a tested out-of-band-delete staleness guarantee; a safe O(1) replacement needs a schema-level counter. See §2 P6.)

**Validation approach:** add micro-benchmarks (synthetic corpora at 10k/50k/100k chunks and a 1000×1000-chunk compare) gated out of CI like the existing manual suites, plus equivalence tests proving the optimized paths return identical results to the current ones. **Found clean:** DB indexing (every hot filter indexed), `buildScopeFilter` (index-friendly EXISTS/IN, no giant materialized IN), single-transaction chunk+embedding inserts, the resident-cache add/remove-id contract, the audit-table prune, the memoized transcript/markdown render, and the windowed documents list.

---

## 6. Phased remediation plan

Each phase is independent and sized for a fresh Claude Code session. Every implementation phase is
characterization-first (pin current behavior → assert correct post-fix → red→green) and ends with the
per-phase ritual (tests green, build/typecheck, docs + BUILD_STATE updated, commit).

### Phase A — Financial correctness (C1, + C5) ✅ REMEDIATED (2026-06-30, branch `audit-2026-06-30-phaseA-financial`)
- **Goal:** stop withholding a correct total on a balance-less-gap statement; resolve the zero-amount classification split.
- **Scope/files:** `skills/tools/bank-statement.ts` (`reconcileBalances`, `summarizeCashflow`/`categorizeRow`); `tests/unit/skills-bank-statement-tool.test.ts`; new `tests/unit/money.test.ts` (T4).
- **Steps:** (1) Add a failing characterization test for the gap-row chain (and the zero-amount surfaces). (2) Implement the `sinceLastPrinted` accumulator in `reconcileBalances`; revert-to-`unknown` only when a row's *amount* is missing; align the docstring. (3) Pick one zero convention and apply in both summary + categorize. (4) Re-validate `reconciled`/statuses on read (no persisted-figure change; don't bump `BANK_EXTRACTOR_VERSION`).
- **Tests:** gap-row ties-out → all ok/unknown, `reconciled:true`, `complete`; genuine break → `mismatch`; zero-amount consistency.
- **Docs:** known-limitations LINE PARSER + arch §8 reconcile note.
- **Acceptance:** the gap-row statement now yields the verified total; the normal 2-figure de-AT row + the HVB no-balance case stay byte-identical.
- **Risk/rollback:** parsing-only, no schema/IPC change; teeth-check neuter→fail→restore.
- **✅ Outcome:** C1 + C5 fixed and T4 landed (per-finding disposition in §2 C1/C5 + §4 T4 above). Behavior-changing but **parsing-only** — no schema, IPC, or audit-payload change; `BANK_EXTRACTOR_VERSION` left at 3 (reconcile re-runs on read). Verification from repo root: `npm test` **2641 passed / 39 skipped** (was 2593/39 → **+48**: 6 in `skills-bank-statement-tool.test.ts` [C1×5 + C5×1] + 42 in the new `money.test.ts`), `npm run typecheck` and `npm run build` green. The C1 fix is teeth-checked (neuter the accumulator → the two gap tests red → restored byte-identical). The existing de-AT 2-figure row and the HVB no-balance case are byte-identical (re-asserted explicitly). No new financial finding surfaced during verification. Phases B–F remain open; the report is NOT retired.
- **Process note (report location):** this report lives on the `audit-2026-06-30-phaseG-docs` branch and was **not on master**, so Phase A (branched off master per the task) carried it in via `git checkout audit-2026-06-30-phaseG-docs -- audits/full-audit-2026-06-30.md` to add these dispositions. Expect a trivial **add/add** resolution when both branches merge — take the most-dispositioned copy (this Phase A version is a superset of the Phase G version on the C1/C5/T4 lines).

### Phase B — Performance hot paths (P1 ✅, P2 ✅; companion P6 ⏸ deferred, M1 done in Phase G) — REMEDIATED (2026-06-30, branch `audit-2026-06-30-phaseB-perf`)
- **Goal:** remove the dominant per-compare and per-query main-thread cost; no behavior change.
- **Scope/files:** `doctasks/compare.ts` + `doctasks/handlers/compare.ts`, `embeddings/index.ts`, `embeddings/resident-cache.ts`.
- **Steps:** (1) `nearestB` → `dotProduct` + running top-K (no per-call sort). (2) `VectorIndex.search`: when no scope filter, iterate the resident map (model-id filtered) and skip the `SELECT chunk_id`; keep the SQL candidate scan for real scope filters. (3) Gate `computeSignature`'s `COUNT(*)` behind `pending == null`. (4) Delete the duplicate comment block (M1).
- **Tests:** ranking-equivalence (cosine vs dot top-3; scan vs resident-iteration identical top-k) + manual micro-benchmarks (gated out of CI).
- **Docs:** arch Wave-P4 / RAG-6 record (resident-iteration), compare handler note.
- **Acceptance:** identical results; measured main-thread block on a 1000×1000 compare < ~250 ms; per-query allocation drop at 100k.
- **Risk/rollback:** equivalence-tested; the scope-filtered path is unchanged.
- **✅ Outcome (EQUIVALENCE-first, BEHAVIOR-PRESERVING — no schema/IPC/audit-payload change):** **P1 ✅** (`dotProduct` + running top-K, extracted to the pure `compareNearestNeighbors`) and **P2 ✅** (resident-map iteration on the unscoped path; scoped scan byte-unchanged; `modelByChunk` added to the cache for the in-memory model filter; archived-exclusion preserved via `canIterateResident`). Each has an equivalence test driving the REAL path that proves identical results, and each was teeth-checked (perturb → red → restore). **Step 4 (M1) was already done in Phase G** (the duplicate comment was deleted there). **Step 3 (P6) ⏸ DEFERRED** — see the P6 disposition in §2: dropping the per-search `COUNT(*)` breaks the tested out-of-band-non-max-delete staleness guarantee; a safe O(1) fix needs a schema-level counter (a trigger), out of Phase-B scope. Per-finding detail in §2 P1/P2/P6. **Verification from repo root:** `npm test` **2653 passed / 41 skipped** (was 2641/39 → **+12** equivalence tests [5 `compare-nearest-neighbors` + 7 `vector-search-resident-iteration`], **+2 skipped** = the CI-gated `phaseB-perf-bench` cases); `npm run typecheck` + `npm run build` green. **Measured wins** (CI-gated bench, dev box): P1 compare 1000×1000 **2.2×** (1253→571 ms); P2 unscoped search **5.0–5.5×** at 50k/10k. Phases C–F remain open; the report is NOT retired.

### Phase C — Lock/teardown reliability (R1; latent R2, R3; small R4–R7)
- **Goal:** make chat-partial persistence deterministic on lock/quit; close the latent concurrency/cache hazards.
- **Scope/files:** `ipc/registerWorkspaceIpc.ts`, `main/shutdown.ts`, `ipc/chat-stream.ts`/`inflight.ts`, `services/chat.ts`, `analysis/model-slot-arbiter.ts`, `embeddings/resident-cache.ts`, plus the R4–R7 leaf files.
- **Steps:** (1) Track a per-stream settled promise in `inFlightStreams`; `await` them in `lockWorkspace` (and `shutdown.ts`) after abort, before purge/lock; guard `appendMessage` against a locked DB. (2) Arbiter: install abort cleanup on the fast path too (or unify holder accounting). (3) Resident cache: reconcile into a scratch map; commit only on success. (4) R4–R7 one-line guards.
- **Tests:** deterministic gated-exit interleaves (fast `stop()` vs pending abort-unwind → partial persists, no rejection; parked-chat abort → consistent holders + build resumes; reconcile-throw → next query equals from-scratch). Teeth-check each.
- **Docs:** arch §37 family + GPU §5.5c cross-refs.
- **Acceptance:** no lost partial / unhandled rejection on lock; latent races have RED→GREEN guards.
- **Risk/rollback:** behavior-preserving; each guard independently revertible.

### Phase D — Renderer lifecycle & a11y guards (F1; F3, F4; small F2, F5–F8)
- **Goal:** stop post-unmount setState + cross-conversation text leak; tidy the small renderer items.
- **Scope/files:** `chat/DictationButton.tsx`, `screens/ChatScreen.tsx`, `screens/ImagesScreen.tsx`+`images/AnswerThread.tsx`, `chat/Transcript.tsx`, `chat/Composer.tsx`, `lib/visionSession.ts`.
- **Steps:** (1) `mountedRef`-guard `stopAndTranscribe`'s `onText`/`onError`/`setState`. (2) Guard the suggestion-debounce setState. (3) Disable per-turn image actions while busy (or surface `images.err.busy`). (4) Memoize `localizeServerCopy`. (5) Optional: F5 rAF, F6 announcer fallback, F7 deferred slice, F8 per-job scoping.
- **Tests:** resolve `transcribeDictation` after unmount → no `onText`/act-warning (mirror `Dictation.test.tsx:264`); busy "Try again" disabled/feedback.
- **Docs:** renderer record (FE-4 family extension).
- **Acceptance:** no setState-after-unmount in the dictation/suggestion paths; busy image action gives feedback.

### Phase E — Security consistency (S1 decision, S2, S3; re-affirm S4)
- **Goal:** resolve the audit-log filename policy explicitly; close the two parity/cap gaps.
- **Scope/files:** `ipc/registerDocsIpc.ts`, `doctasks/handlers/shared.ts`, `audit.ts` (policy comment), `security-model.md`; `skills/manifest.ts`; `ipc/registerDictationIpc.ts`.
- **Steps:** (1) **Decide S1** (align import to the chat/collection bar — drop the title from the message — or accept + document the export carries filenames). (2) `statSync` size pre-check in `parseSkillManifestFromDir`. (3) `requireUnlocked()` on `transcribeDictation`. (4) Re-affirm S4 as the §22-M2 residual (or add a download-host allowlist).
- **Tests:** audit privacy sentinel over import/reindex/materialize + the export payload; over-cap drop-in folder skipped; dictation rejects when locked.
- **Docs:** security-model.md (filename policy decision), known-limitations if accepted.

### Phase F — Test-suite robustness (T1–T4; T5–T7 as backlog) — test-only
- **Goal:** remove the timing-dependent and implementation-detail oracles; close the rollback + money coverage gaps.
- **Scope/files:** `tests/integration/vision-teardown.test.ts`/`vision-cancel.test.ts`, `tests/renderer/DocumentsScreen.test.tsx`, new rollback tests, new `tests/unit/money.test.ts`.
- **Steps:** (1) Replace vision real-timer sleeps with a deterministic park gate. (2) Pair render-count deltas with behavioral assertions. (3) Add injected-failure rollback tests for `commitNode` + categorize persist (+ ideally the ingestion insert loop). (4) Add the `money.ts` pure-function table test. (5) Backlog: T5 sleep sweep, T6 flag-transition spy, T7 numeric-host assertion.
- **Acceptance:** two consecutive full runs identical; the new rollback/money tests red→green on injected faults; `git diff src/` empty.
- **Note:** T4 (money unit) and a `reconcileBalances` characterization test should ideally land **before/with Phase A**.

### Phase G — Documentation reconciliation (D1–D10, M1) — docs/comments-only ✅ REMEDIATED (2026-06-30, branch `audit-2026-06-30-phaseG-docs`)
- **Goal:** restore the topic docs + barrel comment as the as-built source of truth after DX-1/DX-3.
- **Scope/files:** `docs/architecture.md` (§1177-1190 module map, "Six"→"Seven", ING-6/ING-8 + compare citations, §36 split note), `docs/rag-design.md:1230`, `services/doctasks.ts` header, `docs/user-guide.md` (Move/Add label + toolbar actions), `README.md`/`security-model.md` cosmetic, `CHANGELOG.md`/`package.json` version.
- **Acceptance:** every cited symbol/path resolves; the doctasks section describes the `handlers/`/`context.ts`/`MODEL_TASK_HANDLERS` layout; no behavior claim changed.
- **Risk:** none (docs/comments only).
- **✅ Outcome:** all of D1–D10 + M1 fixed (per-item disposition in the §3 table / §2 M1 above). Verification: `npm test` **2593 passed / 39 skipped** (identical to the master baseline — the doctasks + Documents suites byte-equal), `npm run typecheck` and `npm run build` green. M1 is the sole `src/` touch (comment-only). `package.json` deliberately left at `0.1.34` (D9 lighter-touch). The report is NOT retired — phases A–F remain open.
- **Discovered during verification — same-class but NOT in the D-list (transparent extension / carry-forward, not silent scope creep):**
  - **rag-design.md:912** — "the two compare-path decodes (`doctasks/manager.ts`)" was a 4th instance of the exact D4 root cause (compare run-path → `handlers/compare.ts`); since leaving it would make the docs self-contradictory after the D4 repoints, it was **folded into the D4 fix** (repointed to `handlers/compare.ts`) and recorded here.
  - **`doctasks/compare.ts:22-24`** (a `src/` *code comment*: "The manager embeds the nodes lazily on first use … the diff/reduce live in the manager") — stale after DX-1 (both now run from `handlers/compare.ts`). **NOT changed** — the audit framed M1 as "the one `src/` touch" of this phase, so this second `src/` comment is left for a follow-up (a one-line comment fix; behavior-irrelevant).
  - **`architecture.md:3782` and `:4101`** — both cite `doctasks/manager.ts` for the **`categorize`** kind (the run-fn relocated to `handlers/categorize.ts` by DX-1; `:4101` is a historical DOC-N2 ledger row). This is a *different* relocation than D4 (categorize, not compare) and the audit never raised it. **NOT changed** (out of D-list scope); flagged here for a future docs pass. Note `manager.ts` still genuinely owns the categorize *dispatch* (queue/pump + the D26 chat↔task exclusion), so `:3782`'s file list is incomplete rather than wrong, and `:4101` is accurate as a point-in-time disposition.

---

## 7. Recommended execution order

Dependencies are light; phases are independent. Suggested order and rationale:

1. **Phase G (docs) first — cheapest, zero code risk, unblocks every subsequent session.** D1–D5 actively misdirect a future agent to the wrong files; fixing them first makes Phases B/C/F faster and safer. Can also run in parallel with anything.
2. **Phase A (financial correctness) — highest user-trust impact**, isolated, parsing-only. Land the `reconcileBalances` characterization test (from Phase F's T4 work) *with* it.
3. **Phase B (perf hot paths) — concrete, low-risk, equivalence-tested wins** with the biggest scale payoff (P1/P2). No dependency on others.
4. **Phase C (reliability) — closes the one live race (R1) + latent hazards.** Independent; touches the lock/quit paths Phase E also touches lightly, so sequence C before E to avoid overlap on `registerWorkspaceIpc.ts`/`registerDictationIpc.ts` if done close together.
5. **Phase F (tests) — make the latent guards self-enforcing** (T1/T2/T3) before or alongside the code phases they protect; the rollback tests (T3) are a good safety net before any future ingestion/tree refactor.
6. **Phase D (renderer) — F1 is the only real renderer bug; the rest are polish.** Independent.
7. **Phase E (security consistency) — mostly a policy decision (S1) + two small guards.** Independent; sequence after C if both touch `registerDictationIpc.ts`.

**Cross-phase dependencies:** Phase F's `reconcileBalances` characterization test ↔ Phase A (do together). Phase B's P6 companion assumes P2 lands first. Phases C and E both lightly touch dictation/workspace IPC — don't run them in conflicting branches simultaneously. Everything else is parallelizable.

---

### Appendix — methodology & scope
Read-only audit by seven personas (security, backend correctness, reliability, renderer, performance,
testing, documentation) plus first-hand validation of the top findings (C1 reconcile trace, R1 lock
handler, P1/P2 hot paths, S1 audit policy) against the actual code. All dispositioned/accepted residuals
through architecture.md §38 were deliberately excluded. Findings are evidence-driven with file:line
citations; hypotheses are labeled. No code was modified.
