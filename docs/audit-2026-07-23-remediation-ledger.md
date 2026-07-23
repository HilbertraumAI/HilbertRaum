# Remediation ledger — audit 2026-07-23 wave

Branch: `fix/audit-2026-07-23-remediation` (off `master` `bbf26add`, v0.1.55)
Baseline: `bbf26add` · typecheck ✓ · repo-hygiene 12/12 ✓ · `tests/unit` 1656 pass / 102 files ✓
Machine: i7-1185G7 / 8 logical cores / 17 GB RAM (~3 GB free under load); local node **v22.18.0**,
npm 10.9.3 on the shell PATH (BUILD_STATE §2 records v24.13.0 / npm 11.6.2 — see backlog B-01).

Working paper. Transient with the plan and the report; folded into the durable
`architecture.md` close-out ledger at Phase 11 and deleted. Keep NUL/BOM-free UTF-8
(`repo-hygiene.test.ts` walks `docs/` on the filesystem).

---

## Carry-forward backlog (issues found mid-wave; each assigned to a phase)

- [ ] **B-01** — the shell PATH node is **v22.18.0 / npm 10.9.3**; `package.json` `engines` declares
  `node >=22.5` (satisfied) but `npm >=11` (**not** satisfied locally), the same dead-policy floor
  AUD-26 says CI must exercise. Only affects local gate runs
  (vitest is unaffected); relevant context for Phase 9a's CI Node bump. *Assigned: Phase 9a
  (informational — do not "fix" the local box).*
- [ ] **B-02 — `result_tables` is the SAME cascade hole, one table over.** (Found by the Phase-1
  verifier.) `db.ts:270-280` gives `result_tables.message_id` an identical `ON DELETE CASCADE`, and
  `restoreMessage` re-inserts the `messages` row ONLY. So on the two legs designed to lose nothing —
  the F2 non-abort-failure restore and the CB-2 Stop-before-first-token restore — an **un-reviewed**
  answer that carried a result table (the bank-statement "Export CSV" artifact) comes back with its
  table permanently gone; `hasResultTable` (a derived join) then reads false and the export
  affordance silently disappears from a "fully restored" answer. Lower severity than AUD-01 (the
  answer text survives; the artifact is derived) but not reproducible without re-running the model.
  The AUD-01 refusal does **not** cover it and never claimed to. Note the correct fix differs: a
  *successful* regenerate SHOULD drop the old table (the answer is legitimately replaced), so the
  bug is confined to the restore legs — extend the `DeletedMessage` snapshot to capture and replay
  the `result_tables` rows. *Assigned: **Phase 1b** (new sub-phase, runs after Phase 2).*
- [ ] **B-03 — no in-app way to delete an evidence review.** `deleteEvidenceReview` is implemented,
  wired to `evidence:delete` and exposed in preload, but there is **zero** renderer call site
  (verified independently twice; `deleteReviewSelection` is a different thing — one selection item
  inside a review). This is what forced the AUD-01 refusal copy away from "delete the review first"
  to "ask your question again as a new message". *Assigned: Phase 7 if it fits the review-UI file
  set, else deferred-with-registration at close-out.*
- [ ] **B-04 — the AUD-01 refusal is logged as an ERROR.** Because the throw is inside
  `withChatStream`'s try, a deliberate policy refusal writes `[ERROR] Document answer failed` to the
  local log and emits on `chat:error`. Content-free (no review title, no answer text), so no privacy
  issue — a severity misclassification / log-noise nit, and the price of centralizing at the choke
  point. Contrast `main.chat.nothingToRegenerate`, thrown in the handler and never logged.
  *Assigned: Phase 10 loop if cheap, else deferred-with-registration.*
- [ ] **B-05 — "Try again" has no renderer review gate** (only "Answer without it" does). Unreachable
  today: `canTryAgain` requires screen `mode === 'chat'`, `onTryAgain` bails on documents mode, and
  plain-chat answers persist neither citations nor coverage so they are never `isReviewEligible`. The
  one way in is the CR-5-documented screen-mode/conversation-mode divergence, where main refuses.
  Proper fix needs a per-action disabled+title prop on `MessageActions` (it only has a row-wide
  `disabled`). UX consistency only, no data loss. *Assigned: bundle with B-03.*
- [ ] **B-06 — pre-existing, OUT of wave scope, recorded so it is not lost:** (a) `src/main/index.ts`
  has no `requestSingleInstanceLock`, so two app instances could open one workspace DB (the sole
  theoretical cross-process vector for any check-then-act pair in main); (b)
  `assertChatStreamReady`'s in-flight check is separated from `inFlightStreams.set` by awaits, so two
  concurrent invokes on one conversation can both pass (not a data-loss hole after Phase 1 — both
  refuse on a reviewed turn, and the second delete finds a user turn and returns null).
  *Assigned: none — close-out disposition "deferred, registered".*

- [ ] **B-07 — `build-commercial-drive.ps1` still invokes children with a bare `&` and no
  try/catch** (`Run()` and the weight gate). A child's terminating error propagates and kills the
  parent before its own `$LASTEXITCODE` handling — at the weight gate that means the whole **NOT
  SELLABLE problem list is never printed** and the operator sees a raw PowerShell exception instead.
  Phase 4 removed the specific `Write-Error` trigger from every child it calls, so the exposure is
  now narrow; the fix is the same `Invoke-FetchScript` shape `prepare-drive.ps1` now has. *Assigned:
  deferred-with-registration (out of the audit's stated scope).*
- [ ] **B-08 — AUD-24 class on a path the finding did not name:** the `llama_cpp`/`whisper_cpp`
  **archive** download has no delete-before-refetch. A run interrupted AFTER the archive fully
  downloaded but BEFORE extraction leaves a complete archive that path never deletes; every later
  run then resumes past EOF → HTTP 416 → all five outer attempts fail → `curl failed after retries`
  → exit 1, **permanently**, with no message telling the operator to delete the stale archive.
  Same mechanism, proven for the sibling path against a local range-aware server. *Assigned:
  deferred-with-registration.*
- [ ] **B-09 — AUD-24 stays open for the 4 manifests with no `download.size_bytes`**
  (`chat/gemma-4-26b-q4`, `chat/gemma4-coding-q8`, `chat/qwen3.5-9b-q8`,
  `vision/qwen2.5-vl-3b-instruct-q4`). The refined guard deliberately fails OPEN there — behaviour is
  exactly pre-fix (416 no-op, the post-download verify deletes, the next run self-heals), so it is
  strictly no worse. Closing it is one line per manifest, but `size_bytes` must be a *true* byte
  count, so it needs HEAD requests against the four URLs and a manifest edit outside `scripts/`.
  The vision manifest matters most (it is in the `-WithAssets` default set and is two files).
  *Assigned: deferred-with-registration.*
- [ ] **B-10 — the AUD-24 size guard fails OPEN, so it is silently disable-able.** If a future
  refactor drops the size argument at either call site, or the manifest field is renamed, the guard
  never matches, nothing errors, and AUD-24 is quietly back for every model. Nothing in CI would
  notice. *Assigned: **Phase 5** — Phase 4 handed over three ready-to-write `script-drift.test.ts`
  assertions (see the Phase 4 outcome below); Phase 5 owns that file.*
- [ ] **B-11 — latent first-match hazard:** `size_bytes` for the main GGUF is read with the flat
  whole-file accessor, so it returns the FIRST match. Correct today (the schema puts `download:`
  before `mmproj:`, and the one manifest with an mmproj block carries no `size_bytes` at all), but a
  future manifest that gave `size_bytes` ONLY to its mmproj block would test the main GGUF against
  the projector's much smaller size and could delete a legitimate large partial. The same
  first-match design is already used for `url`/`sha256`, which are always present in the main block
  so they cannot mis-attribute. *Assigned: deferred-with-registration (reopen only if a manifest
  ever adds mmproj `size_bytes`).*

- [ ] **B-12 — the TEXT-path adopt has the same weak-guard shape AUD-04 fixed.** `adoptActiveJob`
  (`renderer/lib/translateSession.ts`) gates only on `snapshot.activeJobId`, which is null in EVERY
  terminal state, and its post-await re-check is the identical null test. Reachable: the user hits
  Stop, `stopActive` sets `cancelled` + `activeJobId = null` and fires
  `translateCancel(...).catch(() => {})` — the rejection is SWALLOWED, so if that IPC fails main
  keeps the job `translating`; the next Translate mount re-adopts it and the panel flips from the
  user's cancelled/held result back to "Translating…" with `output` replaced by `job.text ?? ''`.
  Narrower than AUD-04 (only the Translate screen starts a text job, so there is no foreign-starter
  hijack). Fix shape mirrors Phase 3: gate on the store being genuinely empty, not on the id alone.
  *Assigned: Phase 10 loop if cheap, else deferred-with-registration.*
- [ ] **B-13 — nothing re-adopts the GLOBAL doc-task store after a renderer reload** (Medium,
  pre-existing, unrelated to the Phase-3 change). `renderer/lib/doctasks.ts` exposes no adopt entry
  point and `DocumentsScreen` only subscribes, so after a reload a still-running
  summary/translation/compare/tree task loses its row busy state, its Cancel affordance and the chat
  "task is busy" banner — **while the backend lane stays held, so new task starts are refused with a
  busy error the UI cannot explain.** This is also the direct cause of the Phase-3 residual (the
  file-translate adopt cannot tell a Documents-started task from its own once that store is empty).
  *Assigned: deferred-with-registration — wants its own issue/wave, not this one.*

## Decisions log

- **D-W1 (plan §3, carried in):** the verified-and-dismissed engine-download tar-child-on-quit item is
  a confirmed **live extension of the known residual** BUILD_STATE §5 item 9 ("Downloads on quit" —
  the registered residual names the *model* download `.part` stream; the sighting is the separate
  *engine* downloader's tar child). **Not in this wave**; recorded here so a future
  downloads-teardown wave inherits it.
- **D-W2 (plan §3):** DV-4 (Skills auto-fire card label duplication) is Info/no-action — not
  scheduled.
- **D-W3 (plan §0.7):** reference hygiene — no durable artifact (code/test comments, commit messages,
  `BUILD_STATE.md`, `CHANGELOG.md`, committed docs, the `architecture.md` close-out ledger) may cite
  the audit report, this plan, this ledger, or `invoice-audit-ia1.test.ts` by path or filename.
  `AUD-nn` is a label that must resolve to the self-contained Phase-11 close-out ledger.

## Phase outcomes

### Phase 0 — wave setup — DONE
- Branch `fix/audit-2026-07-23-remediation` created off `master` `bbf26add` (== `origin/master`).
- Ledger created (this file), NUL/BOM-free UTF-8.
- Baseline gate: `apps/desktop` `npm run typecheck` **green**;
  `npx vitest run tests/integration/repo-hygiene.test.ts` **12/12 pass**;
  `npx vitest run --reporter=dot tests/unit` **1656 pass / 102 files** (18.83 s).
  Full suite deliberately NOT run here — Phase 10 owns it (plan §0.2).
- Machine profile recorded above; backlog seeded with B-01.

### Phase 1 — AUD-01 (evidence-review data-loss guard) — DONE, verifier SIGNED OFF WITH RESIDUALS

**Decision D-1a (refuse, not confirm).** There is no per-turn confirm surface in the transcript, and
a "delete your review to re-answer" dialog would offer to destroy work the app has no way to give
back (B-03: no review-delete affordance exists at all). So the destructive turn is **refused** at the
one shared choke point, with copy naming the alternative that actually exists.

**Decision D-1b (copy correction, orchestrator-ratified).** The planned copy "reopen or delete the
review first" is **false on both counts** — reopening does not unblock (the guard keys off review
EXISTENCE by design: a draft review is human work too) and there is no delete affordance. Shipped
copy: EN "This answer has an evidence review. Answering again would delete the review with its
decisions and notes — ask your question again as a new message instead." (DE parity, native).

**Decision D-1c (disable, not hide).** Plan step 2 said add the review check to `canUndo` (hiding the
button). Implemented instead as rendered-but-`disabled` + explanatory `title`: the review chip sits
in the same action row, so a vanishing button reads as a bug. Rationale recorded in code and in the
durable `architecture.md` amendment.

**Decision D-1d (snapshot extension rejected).** Extending the F2/CB-2 `DeletedMessage` snapshot to
carry the whole review chain was considered and rejected: much larger, and it would still leave every
unguarded caller destructive. (Note this decision does NOT transfer to B-02, where snapshot-and-replay
IS the right shape — see the backlog entry.)

- **Files:** `src/main/ipc/chat-stream.ts`, `src/main/services/chat.ts`,
  `src/main/services/evidence-reviews.ts`, `src/renderer/chat/Transcript.tsx`,
  `src/shared/i18n/{en,de}.ts`, new `tests/integration/regenerate-evidence-review-guard.test.ts`,
  new `tests/renderer/TranscriptReviewUndoGuard.test.tsx`, `docs/architecture.md`,
  `docs/user-guide.md`.
- **Handoff to later phases:** `hasReviewForMessage(db, messageId): boolean` — a cheap indexed
  `SELECT 1 … LIMIT 1` existence probe, deliberately NOT `getEvidenceReviewForMessage` (which loads
  every item row and recomputes the ready gate). **Phase 6 should reuse it** rather than adding a
  second probe. Also new: `getRegenerableAssistantMessageId(db, conversationId)` in `chat.ts` — now
  the single owner of the "which row does regenerate target" query, with
  `hasRegenerableAssistantReply` re-expressed in terms of it so the precondition, the guard and the
  delete cannot drift apart.
- **RED evidence:** pre-fix the review chain went `{reviews, items, links, exports} = 1,1,1,1 →
  0,0,0,0` on FOUR legs — successful re-answer through the real `askDocuments` IPC handler, the F2
  non-abort-failure restore, the plain-chat channel through the shared wrapper, and the CB-2
  Stop-before-first-token empty-resolve restore. Renderer RED: `expect(element).toBeDisabled()` on a
  live `<button class="msg-skill-undo">`, plus the blocked handler firing 1× on click.
- **GREEN (orchestrator's own run):** `regenerate-evidence-review-guard` 6 ✓ ·
  `TranscriptReviewUndoGuard` 6 ✓ · `rag-regenerate-ipc` ✓ · `chat-stream-regenerate` ✓ ·
  `evidence-reviews-ipc` 15 ✓ · `repo-hygiene` 12 ✓ · `unit/i18n` ✓ → **7 files / 60 tests pass**.
  `npm run typecheck` green.
- **Orchestrator corrections to the implementer's work:** (1) it split an `architecture.md` sentence
  in half, leaving a dangling "Two additive" fragment and a duplicated clause — repaired into a
  proper paragraph; (2) its user-guide text asserted a "Try again" behaviour unreachable today
  (`canTryAgain` requires chat mode; reviews only exist on documents answers) — reworded to claim
  only what is true.
- **Adversarial verifier (fresh context): SIGNED OFF WITH RESIDUALS.** Airtight for
  `evidence_reviews`; no bypass constructible. Evidence: only TWO `DELETE FROM messages` exist in
  `src/` — the regenerate one (now guarded, same function, same tick) and `deleteConversation` (the
  D-2 warn-and-count confirm); all 8 `withChatStream` call sites wrap their runFn in
  `withRegenerateGuard`, and it is the only caller of `deleteLastAssistantMessage`. Target-row
  divergence disproved structurally (identical SELECTs; `messages` is a rowid table so
  `created_at DESC, rowid DESC` is a total order) **and** empirically: 19 constructed cases +
  **400-transcript fuzz with heavy timestamp collisions → 0 mismatches**. Race: the check and the
  delete are three straight-line synchronous `node:sqlite` calls with no `await` between them, and no
  worker/utility process opens the workspace DB. **Mutation-check: neutering the main guard reddens
  4/6 integration tests on the `chainCounts` DATA assertion (not merely the error string); neutering
  the renderer gate reddens 3/6 — the negative controls stay green in both.** The verifier edited
  source twice and reverted byte-identically (working-diff sha256 equal before and after; confirmed
  independently by the orchestrator, hash `a1b8d069`).
- **Residual (accepted, no `known-limitations.md` entry):** `reviewSummaries` is fetched
  asynchronously and committed in one batch after the whole per-message loop resolves, so for that
  window the undo renders enabled on a reviewed turn. A click inside it optimistically drops the
  message from view, **main refuses with nothing deleted**, the localized refusal lands in the error
  banner, and the `catch`'s `refreshIfVisible()` re-reads `listMessages` and puts the answer back —
  a brief flicker plus an honest banner, **no data loss**. Deliberately NOT added to
  `known-limitations.md`: that register is for accepted user-visible gaps, and this is a sub-second
  self-healing race where the safety property holds. (Phase 6's AUD-12 batch channel shrinks this
  window as a side effect.)
- **Discovered → backlog:** B-02 (result_tables sibling cascade — the most valuable find), B-03, B-04,
  B-05, B-06.

### Phase 4 — AUD-05 + AUD-24 (provisioning-script robustness) — DONE

**Decision D-4a (`Write-Host` + explicit `exit`, not `try/catch` around every site).** The scripts
already used `Write-Host -ForegroundColor Red` + `exit` at two pre-existing failure sites, so the
fix is the pattern the file itself established, not a new one. `try/catch` is used only where the
problem is a *child process* terminating the parent (`prepare-drive.ps1`'s new `Invoke-FetchScript`
wrapper around all four `&` child invocations).

**Decision D-4b (AUD-24 scoped to the case that cannot self-repair) — orchestrator-directed
correction.** The implementer's first pass deleted the destination on ANY `mismatch`. I rejected
that: `Get-FileState`/`file_state` return `mismatch` for a **cross-run partial** too, and
`fetch-models.sh`'s own header advertises "RESUMES partial downloads (curl -C - / aria2c)" as a
feature — so the unconditional delete traded a Low, already-self-healing bug (416 costs one wasted
run) for a worse one: **every interrupted multi-GB weight download restarting from zero on a DIY
user's flaky link.** The shipped rule instead deletes only when resume provably cannot help — when
the bytes on disk already reach the manifest's `download.size_bytes`. Shorter file = resumable
partial = untouched. No `size_bytes` = no delete (pre-fix behaviour, strictly no worse). The
asymmetry with `fetch-runtime.{ps1,sh}` (OCR files: delete unconditionally — few MB each, no size
field in `runtime-sources.yaml`, no partial worth saving) is now stated in BOTH files' comments so a
future reader does not "harmonize" them back into a bug.

- **Files:** `scripts/fetch-runtime.ps1`, `scripts/fetch-models.ps1`, `scripts/prepare-drive.ps1`,
  `scripts/verify-models.ps1`, `scripts/fetch-runtime.sh`, `scripts/fetch-models.sh`. No `docs/`
  change (the behaviour now matches what the scripts already documented).
- **RED evidence (real host, PS 5.1 via `powershell.exe -File`, scratch replicas + the real
  pre-fix script from `git show HEAD:`, nothing downloaded):**
  (a) OCR-loop shape — aborted at the FIRST `Write-Error`; `eng:` never printed, the trailing
  summary never printed, exit 1. Against the real pre-fix `fetch-runtime.ps1` pointed at an
  unresolvable host: `deu` failed, **`eng` was never attempted**.
  (b) `Write-Error ...; exit 2` -> **exit 1** (the documented config-error code collapsed).
  (c) parent `& $child` — killed at the call site; the tolerant `$LASTEXITCODE` branch and the
  entire OCR step never ran, exit 1.
  (d) AUD-24, against a local range-aware server with a complete-but-wrong file:
  `GET /deu.traineddata.gz Range=bytes=4096- -> 416`, ONE request, zero bytes — the redo was a
  guaranteed no-op.
- **GREEN evidence (four-case verification, both engines, local server):**
  (a) complete-but-wrong (size == expected) -> deleted, `(no range) -> 200`, VERIFIED in ONE run;
  (b) **short partial (1000 of 4096 bytes) -> NOT deleted, `Range=bytes=1000- -> 206 (3096 bytes)`,
  VERIFIED** — only the missing tail crossed the wire, i.e. cross-run resume is preserved;
  (c) oversized garbage -> deleted, refetched clean;
  (d) manifest without `size_bytes` -> not deleted, resume attempted, 416, post-download verify
  deletes, self-heals next run (pre-fix behaviour, deliberately).
  Dry-run safety re-verified in both engines (nothing deleted). Real fixed `-Family ocr` against the
  unresolvable host now attempts **both** files and exits 1 from the trailing summary. Real fixed
  whisper->OCR sequence: whisper miss prints the tolerant note and **provisioning continues to the
  OCR step**, exit 0.
- **Orchestrator's own gate:** zero non-comment `Write-Error` left in the four provisioning `.ps1`;
  PowerShell AST parse OK on all five `.ps1` (incl. `build-commercial-drive.ps1`); `bash -n` OK on
  both `.sh`; all six files NUL-free, BOM-free, `.sh` byte 0-2 = `23 21 2f` (`#!/`);
  `script-drift` 17 ok, `repo-hygiene` 12 ok, `prepare-drive-default-set` 4 ok,
  `commercial-drive` 34 ok -> **4 files / 67 tests pass**.
- **AUD-05 severity nuance for the close-out record (worth keeping):** the whisper win URL is a
  **live release asset** (HEAD: 302 -> `release-assets.githubusercontent.com` -> 200,
  `Content-Length: 4093849`), so on a **Windows** build host the whisper step only failed
  transiently. But on **mac/linux** `-Family whisper_cpp` selects no build at all (the yaml pins a
  win-only whisper asset), which is the CONFIG-error path — so there the dead tolerant branch
  aborted `-WithAssets` provisioning, and skipped the OCR fetch, **100% of the time, every run**.
  The documented "a whisper miss is a warning, not a failure" contract was fully dead exactly where
  it was written to matter.
- **Bonus fixes found and made in-phase:** `verify-models.ps1` carried the same dead-`exit 2` bug at
  an unlisted site — and `build-commercial-drive.ps1` invokes it with a bare `&` then appends to its
  `$problems` list, so that terminating error would have killed the drive build **before it printed
  its NOT SELLABLE verdict**. Also the OCR loop's non-curl `Invoke-WebRequest` fallback was equally
  fatal under `Stop` (a host without `curl.exe` still aborted at the first bad file, defeating the
  whole point); now try/catch + `$failed++; continue`.
- **Handoff to Phase 5** (which owns `script-drift.test.ts`): three ready-to-write assertions were
  handed over rather than written, to avoid a two-phase edit of that file —
  (1) no non-comment `Write-Error` in the four provisioning `.ps1`;
  (2a) the `fetch-models` delete is SIZE-GUARDED (assert the size comparison precedes the first
  `Remove-Item`/`rm -f`, i.e. the delete is nested inside the guard);
  (2b) the `fetch-runtime` OCR delete IS unconditional and stays so (the asymmetry is intentional);
  (2c) the size argument actually reaches the guard at both call sites — **this is the one that
  catches the silent fail-open regression (B-10)**.
- **Discovered -> backlog:** B-07, B-08, B-09, B-10, B-11.

### Phase 3 — AUD-04 (Translate adopt terminal-clobber / foreign-task hijack) — DONE

**Decision D-3a (the gate is "this store is EMPTY", not "not busy").** `busy` is false in every
TERMINAL state, so the busy-only guard let a later mount run over a FINISHED translation and wipe its
held `output`/`gaps`/`truncated`/`resultDocumentId`. The recovery exists for a store that died with a
renderer reload — and such a store is `idle`; any other state is a session the panel is still showing.

**Decision D-3b (the post-await re-check gets the SAME rule) — implementer's call, ratified.** The
plan only named the entry guard. The implementer changed the post-await re-check to `state !== 'idle'`
too, and justified it with a REACHABLE path rather than a hypothetical: `translateDroppedFiles`
reaches `fail('multiDrop')` / `fail('noPath')` / `fail('docTaskBusy')` **synchronously**, so a drop
the user makes while the `getActiveDocTask` IPC is in flight lands `state:'failed'` with `busy:false`
— a busy-only re-check sails straight past it and replaces the error banner the user just triggered
with "Translating…". It cannot cost a legitimate adopt: entry already required `idle`, so the
re-check now fires only when something else genuinely took the panel during the await, and that owner
must win. Agreed — the entry guard and the re-check must enforce the same invariant or the documented
no-op is true only at function entry and not at the moment of the destructive `set`.

**Decision D-3c (foreign check placed post-await, by necessity and on the merits).** It compares
`task.jobId`, which does not exist before the await. That placement is also strictly better:
DocumentsScreen's `startTask` writes the global store only AFTER its own `startDocTask` round-trip
resolves, so a pre-await read could miss a foreign task main already reports as active.

- **Files:** `src/renderer/lib/fileTranslateSession.ts`,
  `tests/renderer/fileTranslateSession.test.ts`. Plus `docs/known-limitations.md` (added by the
  orchestrator — the implementer correctly declined to edit `docs/` while another agent held it).
- **RED evidence** (source temporarily reverted to the pre-fix guard, then restored verbatim —
  `grep RED-CAPTURE` over `src/` and `tests/` returns nothing):
  `expected 'translating' to be 'done'` (terminal clobber),
  `expected 'translating' to be 'idle'` (foreign-task hijack),
  `expected 'translating' to be 'failed'` (terminal-during-await).
  Each RED isolates ONE fix component — RED 1 runs with an EMPTY global store so only the entry
  guard can block it; RED 2 from an idle store so only the foreign check can; RED 3 goes terminal
  AFTER the entry guard passed so only the re-check can. That is a good teeth design: no single
  change can make all three pass.
- **GREEN (orchestrator's own run):** `fileTranslateSession` 29 ok, `TranslateScreen` 24 ok,
  `doctasksStore` + `translateSession` ok -> **4 files / 69 tests pass**. All four pre-existing adopt
  cases still green, including the genuine post-reload recovery — which now carries an explicit
  `expect(getActiveDocTask()).toBe(null)` pin so a future change cannot break reload recovery while
  keeping the new guards green.
- **Residual (recorded in `known-limitations.md`, not left silent):** after a genuine renderer RELOAD
  the global doc-task store is empty too, so a translation started from a Documents row and still
  running IS adopted into the panel — main tracks document ids but not the originating surface, so
  they are indistinguishable at that point. Benign (the user's own task, real progress, real Stop,
  real result; the materialized document lands under Documents either way). Closing it needs a
  main-side contract change (an `origin`/owner field on the doc-task) — out of scope. **The actual
  AUD-04 repro — plain in-session navigation hijacking a live Documents-row task — is fully closed.**
- **Note (deliberate, not an oversight):** the foreign check treats a `stateUnknown` global entry
  (polling gave up after 3 consecutive IPC failures, so the status may be a stale non-terminal
  snapshot) as LIVE and refuses to adopt. Conservative on purpose: a task whose live state the
  renderer could not learn must not be hijacked into the panel.
- **Discovered -> backlog:** B-12, B-13.
