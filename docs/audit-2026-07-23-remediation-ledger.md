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

- [ ] **B-14 — `getAppStatus.workspaceReady` and `getWorkspaceState` still report *unlocked* during
  the lock teardown** (both keep a bare `isUnlocked()`, deliberately). These are precisely the two
  channels the renderer uses to decide "am I at the gate", so for the whole teardown the UI keeps
  offering content actions that now refuse. Fail-CLOSED, so not a security issue — but it sits in
  tension with the fix's own stated principle that during the teardown "the workspace is locked" is
  the honest answer. Left alone on purpose: safe-defaulting a status read mid-lock would flip the
  offline ceiling for its other callers. *Assigned: deferred-with-registration.*
- [ ] **B-15 — `RuntimeManager.forceRestart` has no workspace check.** The GPU-crash auto-fallback
  re-checks only `this.stopped`, so a GPU crash landing during or after a lock respawns a CPU
  `llama-server` past the lock — the one remaining "a sidecar starts while locked" path. Content-free
  (the crashed child's KV cache died with it), so resource/orphan rather than a leak. *Assigned:
  Phase 2 loop if it is a clean two-line check, else deferred-with-registration.*
- [ ] **B-16 — a second concurrent `lockWorkspace` rejects with the RAW unlocalized vault string**
  `Workspace is locked — unlock it first.` — exactly the class of string `ipc-lock-coverage.test.ts`
  exists to keep out of the UI. Pre-existing and narrow (it takes two overlapping Lock-now invokes).
  *Assigned: deferred-with-registration.*
- [ ] **B-17 — `unlockWorkspace` landing mid-teardown returns `{ ok: true, state: 'unlocked' }`** and
  writes a `workspace_unlocked` audit event while the lock proceeds to completion, so the audit log
  gains a misleading `workspace_unlocked` immediately before `workspace_locked`. The latch correctly
  survives (because `unlock()` early-returns before `beginSession()`), so there is no admission hole
  — this is log fidelity only. Pre-existing. *Assigned: deferred-with-registration.*
- [ ] **B-18 — the lock-latch stand-in tolerance fails OPEN.** `workspaceAdmitsWork` uses
  `isLocking?.() !== true`, so any test stand-in that omits `isLocking` silently never latches. That
  is the deliberate choice (it keeps ~40 existing partial test contexts valid) and it is why the
  shipped `ipc-lock-coverage` stand-in can never detect the latch. Mitigated by the bare-`isUnlocked()`
  allowlist guard assigned to Phase 5. *Assigned: Phase 5 (mitigation) — no further action.*

- [ ] **B-19 — `build-commercial-drive.ps1` still carries the `Write-Error` hazard** the provisioning
  phase removed everywhere else. It sets `$ErrorActionPreference = 'Stop'` and then has two
  `Write-Error "…"; exit 1` pairs, so those `exit 1` statements are DEAD CODE — the observable exit
  code is right today only because the terminating-exception code is coincidentally 1 too, and the
  same exception would still escape a parent's `& .\build-commercial-drive.ps1` invocation.
  Deliberately excluded from the new Phase-5 guard (adding it would redden an untouched file); the
  exclusion and its reasoning are recorded in the test's own comment. *Fix: convert both to
  `Write-Host -ForegroundColor Red` + explicit `exit 1`, then add the file to the guard's list in the
  SAME commit. Assigned: deferred-with-registration.*
- [ ] **B-20 — nothing canonical pins the runtime BINARY names.** `runtime-sources.yaml` carries
  (os, arch, backend, url, sha256, extract_to) but no binary-name field, while both
  `build-commercial-drive` twins hard-code a `bin` column (`llama-server.exe`, `whisper-cli.exe`, …)
  that the sellability gate tests for. A wrong name means the gate looks for a file that never exists
  (drive always rejected) or one that always exists (gate blind). Phase 5 added a twins-agree
  cross-check, which catches ONE script drifting from the other but NOT both drifting together from
  reality. *Fix: add a `bin:` field to `runtime-sources.yaml` (making it canonical), or derive the
  name in TS and spell-check it the way the drive-layout dirs are. Assigned:
  deferred-with-registration.*
- [ ] **B-21 — the two `build-commercial-drive` twins spell the runtime family differently:** `.ps1`
  uses the canonical `llama_cpp`/`whisper_cpp`, `.sh` uses short `llama`/`whisper`. Harmless today;
  Phase 5's `.sh` parser maps it explicitly and raises a named error if an unknown token appears, so
  a third runtime family added to the yaml gets a clear "teach this test the new mapping" failure
  rather than a silent miss. *Fix: normalise the `.sh` to the canonical token. Assigned:
  opportunistic — fold into whichever phase next edits that script.*
- [ ] **B-22 — the NUL/BOM nets have no LINE-ENDING tooth**, the third member of the same
  shipped-artifact byte-trap family. A CRLF-terminated `launchers/start-hilbertraum.sh` or
  `Start HilbertRaum.command` fails on macOS/Linux with the classic `bad interpreter: /bin/bash^M` —
  the same silent-launch-failure blast radius as the BOM this wave now guards, and just as easy to
  introduce from a Windows editor. Out of scope for AUD-06 as written. *Fix: check `.gitattributes`
  first; if it does not pin `* text eol=lf` for these paths, add a CRLF net beside the BOM one.
  Assigned: deferred-with-registration.*

- [ ] **B-23 — `loadResultTable`'s newest-first read has no rowid tiebreak** (`ORDER BY created_at
  DESC LIMIT 1`, `services/tables/store.ts`). Because `result_tables.message_id` is indexed but NOT
  unique, two tables written to one message within the same millisecond leave it unspecified which
  one the "Export CSV" action picks. Latent today (nothing writes two tables to one message), but the
  schema permits the ambiguity — the Phase-1b restore test had to stamp an explicit `created_at` to
  make ordering observable at all. *Fix: `ORDER BY created_at DESC, rowid DESC LIMIT 1`, mirroring
  the `listMessages`/`getLatestMessage` tiebreak idiom. Assigned: deferred-with-registration
  (one-line change, wants its own small test).*
- [ ] **B-24 — `saveResultTable` neither replaces nor dedupes:** it always INSERTs a fresh UUID, so
  a future caller that saved twice for one message would silently accumulate tables, with
  `hasResultTable` staying true and the export picking one per the ambiguous ordering in B-23. The
  schema comment says "ONE generic tabular artifact attached to an assistant message" — an invariant
  the schema does not actually enforce. *Fix needs a DECISION first (enforce with a UNIQUE index +
  delete-then-insert, or document the multi-row shape as intended); the Phase-1b capture/replay
  already handles N rows correctly either way. Assigned: deferred-with-registration.*

- [ ] **B-25 — the OCR engine's own header comment still presents the asar rewrite as the complete
  packaged-app story** (`services/ocr/tesseract.ts`), never saying the rewrite is insufficient or
  that the packaged path currently kills the app. Left untouched deliberately: the fix bundle will
  edit this exact file. *Assigned: the packaged-OCR fix bundle (BUILD_STATE §5 item 16(b)).*
- [ ] **B-26 — `BUILD_STATE.md` §1's "Remaining for release" callout still lists "the packaged-app
  OCR smoke"** among remaining manual-acceptance items, as if merely unrun rather than blocked —
  the same stale framing AUD-07 exists to kill. *Assigned: Phase 11 close-out (cheap, orchestrator).*
- [ ] **B-27 — `BUILD_STATE.md` §5 item 1's "Phase-38 addition"** says a packaged-app OCR smoke
  "must be exercised in the built app". It HAS been exercised, and it crashes. Same class as B-26.
  *Assigned: Phase 11 close-out (cheap, orchestrator).*
- [ ] **B-28 — the `BUILD_STATE.md` retention budget is nearly exhausted:** 1971 / 2000 lines and
  274,779 / 307,200 bytes. The budget test goes red before the wave closes unless a closed wave is
  retired to `docs/build-log.md` first (which is what the test's own failure message instructs).
  Mitigated in-wave by keeping ONE dated entry with a single growing phase-log line instead of an
  entry per phase. *Assigned: Phase 11 close-out — archive this wave's entry per the retention rule.*
- [ ] **B-29 — `docs/build-log.md` carries the SAME relocation-broken link class as AUD-21**
  (`[packaging.md](docs/packaging.md)`), but it is INERT: an unbalanced stray backtick a few lines
  above puts it inside an inline code span under CommonMark pairing, so it never renders as a link
  and the widened check correctly does not flag it. Deliberately NOT fixed and NOT allowlisted:
  `build-log.md` is the frozen archive whose stated convention is prose byte-identity, and both the
  stray backtick and the target sit inside a retired verbatim entry. *Assigned: record-only.*
- [ ] **B-30 — `docs/user-guide.md` §7 describes "Make searchable (OCR)" end to end as a working
  feature with no packaged-build caveat — and the build an end user actually runs IS a packaged
  build.** Phase 8 added the honest note to `troubleshooting.md` (where a user lands after the app
  dies) but deliberately did not rewrite user-facing guide copy: whether shipped user documentation
  should carry a "this feature currently crashes" warning, or whether the fix simply lands first, is
  an **owner product call**. *Assigned: OWNER DECISION, alongside the packaged-OCR fix bundle.*
- [ ] **B-31 — trivial data disagreement:** the Qwen3.5 0.8B's on-disk size is `size_on_disk_gb: 0.7`
  in its manifest but "~0.6 GB" in `model-policy.md`. The real weight is 639,029,504 bytes
  (~0.64 GB decimal / 0.595 GiB), so "~0.6 GB" is the more accurate of the two and is what the new
  README row uses — which means the README now matches `model-policy.md` and not the manifest field.
  *Assigned: opportunistic.*

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

### Phase 2 — AUD-02 + AUD-03 (lock-in-progress latch) — DONE, verifier SIGNED OFF WITH RESIDUALS after one loop

**Decision D-2a (fail-CLOSED across every admission point, not just the named surfaces).** The finding
named doc tasks, translate, vision and the import loop; the implementation routes **all 15 IPC
`requireUnlocked` helpers** plus 3 in-loop docs checks plus 3 service-level guards through one shared
`workspaceAdmitsWork()` predicate (`isUnlocked() && !isLocking()`). During the teardown "the workspace
is locked" is the honest answer, and the renderer swaps to the gate the moment the invoke resolves.
Each module keeps its OWN localized copy — verified line-by-line, all 15 keys byte-identical.

**Decision D-2b (guards in the SERVICES too, not only the IPC handlers).** `DocTaskManager.startDocTask`,
`TranslateJobService.start` and `VisionService.analyze` consult an injected `isWorkspaceLocking` seam,
so non-IPC callers inherit the refusal — the repo's established posture. Both service guards are
unreachable in production today (one call site each, both behind `requireUnlocked`); this is
defence-in-depth, and the comments now say so accurately.

**Decision D-2c (`requireDb()` / `ctx.db` deliberately NOT latched) — load-bearing.** The lock teardown
writes through it: partial-reply persistence, the doc-task unwind's materialize/shred, the
resident-vector purge, and the `workspace_locked` audit event itself. Latching it would make the lock
break itself. Independently confirmed by the verifier: it is not an admission point, because every
caller that could *start* work now passes a guard first.

**Decision D-2d (the disarm is STRUCTURAL) — orchestrator-directed, loop 2.** See MUST FIX 2 below.

**Decision D-2e (`forceRestart` guarded at the composition seam, not in the manager).** `RuntimeManager`
holds no workspace reference at all (its only constructor dep is the factory), so an in-manager check
means threading a probe through `start`/`forceRestart`/`doStart` — restructuring, not a two-liner. The
GPU-crash auto-fallback's only `forceRestart` caller is the `restart` lambda in `main/index.ts`, where
the workspace is already in scope and the same predicate is already used, so the check landed there.
Residual: a future caller added outside that seam would not inherit it — named in both docs.

- **Files (26):** `workspace-vault.ts` (the latch, `cancelLock`, the unlock epoch,
  `workspaceAdmitsWork`), `registerWorkspaceIpc.ts`, `shutdown.ts`, `registerModelIpc.ts`,
  `main/index.ts`, 13 further `register*Ipc.ts`, `doctasks/{manager,context}.ts`,
  `translation/jobs.ts`, `vision/index.ts`, new `tests/integration/lock-admission-race.test.ts`,
  `tests/integration/core-model-ipc.test.ts`, `docs/security-model.md`, `docs/architecture.md`.
- **RED evidence (loop 1):** with the lock handler PARKED mid-teardown (gated boundary fake, real
  encrypted vault, real SQLite, real services), the handler's own stdout showed the finding verbatim —
  `Document task queued {kind:"translation"}`, `Translate job started`, `Vision analyze started` /
  `Vision analyze done`, `Import started` — i.e. all four surfaces admitted while the workspace was
  mid-lock. AUD-03: with the post-hash re-checks neutered, `expected true to be false` on `started`,
  twice (lock-during-hash, and lock+re-unlock-during-hash).
- **Adversarial verifier (fresh context) — the two defects it found, both fixed in loop 2:**
  - **MUST FIX 1 — the failed-lock disarm had ZERO coverage; its test was a tautology.** The case
    "clears the latch when the lock itself fails" never invoked `IPC.lockWorkspace` — it called
    `beginLock()` then `cancelLock()` directly on the controller and asserted the setter worked.
    Proof: deleting `cancelLock()` from the failure catch left **65 tests fully green**. This is the
    highest-consequence line in the change: without it an ENOSPC "Lock now" leaves the workspace
    **open** and the latch **armed**, refusing every content surface with no recovery but a relaunch.
    Replaced with a real test driving `IPC.lockWorkspace` through the real handler via the
    `encryptFileImpl` seam, asserting the friendly localized rejection, `isLocking() === false`, and
    that a content surface actually **admits again** (driven, not flag-read).
  - **MUST FIX 2 — no `finally` disarm: a throw before `lock()` bricked the session.** The verifier's
    probe (sync-throwing `embedder.suspend`) produced `isUnlocked = true, isLocking = true` — and
    `unlock()` **cannot** clear it, because it early-returns before `beginSession()`. Workspace wide
    open, everything refusing, relaunch the only recovery. Reachability was low (all seven boundaries
    are `async`) but it was a **new failure mode the latch introduced**: pre-latch, the same throw
    left a merely retryable failed lock. Fixed structurally — the handler is now
    `beginLock()` -> `try { runLockTeardown(ctx) } catch { if (isUnlocked()) cancelLock(); throw }`,
    with the teardown extracted verbatim and the duplicated inner disarm removed so there is exactly
    **one** disarm point.
- **Mutation proof (loop 2):** removing the single disarm line reddens BOTH new cases
  (`expected true to be false` — the latch stayed armed over a still-open workspace); removing the
  quit latch reddens both quit cases; removing the plaintext self-disarm reddens its case. All
  restored byte-identically and re-verified green. **The old tautological test passed under the same
  mutation** — exactly the gap the verifier flagged.
- **Quit path — a NEW finding, fixed in-phase.** `performShutdown` had the identical admission window
  and armed only the chat runtime's latch. The verifier confirmed the structure but **narrowed the
  impact**, and the fix was implemented to the narrowed version: refuted for translate/embedder/OCR/
  chat (quit uses permanently-latching `stop()`, so `ensureStarted` throws rather than respawning);
  **CONFIRMED for vision** — `stop()` clears `tearingDown` in its own `finally`, so once it resolves
  an admitted `imageAnalyze` builds a FRESH ~4.6 GB `llama-server` that then **orphans at
  `app.exit(0)`**; and **confirmed for import** — an admitted import decrypts to a plaintext transient
  that `app.exit(0)` can strand between the write and the shred. Fixed by arming the same latch first
  in `performShutdown`, covered by two RED-first tests driving the real `performShutdown`.
- **Self-inflicted bug caught by the phase's own new test:** the first draft put the quit latch inside
  the SAME best-effort `try` as the pre-existing runtime latch — a throw from the first call then
  silently skips the second, making whichever runs second optional. The test caught it immediately.
  Now each latch has its own `try`, workspace first.
- **Self-inflicted bug caught in loop 1:** `lock()` is a deliberate NO-OP for `plaintext_dev` (the DB
  stays open), so an unconditional `beginLock()` would have latched a dev workspace **permanently** —
  only `unlock()` clears it, and a plaintext workspace never unlocks again. `lock()` now disarms
  whenever it returns with the DB still open; teeth-checked.
- **Verifier's independent completeness pass:** all **128** `ipcMain.handle` registrations enumerated
  with a parser — 98 latched, 30 deliberately not (status/pre-unlock reads, in-memory stream
  reads/*cancels* which must keep working, file dialogs whose byte-reading follow-ups ARE latched,
  gate lifecycle, downloads/engine install which are pre-unlock by design). **No missed
  content-bearing surface.** Every remaining bare `isUnlocked()` in `src/` (7 sites) is a
  status/settings read, not an admission point. It also proved the assertions are not vacuous: with
  the guards neutered it observed `translator.translate()` called, `createRuntime()` called, a
  document row queued, and a doc task admitted.
- **Docs corrected on the verifier's finding:** `architecture.md`'s "sidecars only ever start
  post-unlock" claim was rewritten in both places to describe what is actually enforced on BOTH the
  lock and quit paths, and the remaining `forceRestart` seam is named **as a gap** rather than implied
  away; `security-model.md` gained the structural-disarm clearing rules and the quit-path section with
  the narrowed impact.
- **Comment correction:** `TranslateJobService.start`'s `cancelled` rationale claimed the renderer
  shows no banner. It does — `TranslateScreen`'s `ERR_KEY` has no `cancelled` entry, so it falls
  through to the generic `translate.err.runtimeFailed`. (Vision's equivalent claim IS correct.)
  Comment corrected rather than adding renderer copy for an unreachable path.
- **GREEN (orchestrator's own runs):** typecheck green; `lock-admission-race` + `unit/shutdown` +
  `core-model-ipc` (30) + `workspace-ipc` + `ipc-lock-coverage` -> **5 files / 71 tests**; independent
  spot-check of the touched surfaces `gpu-ipc` + `runtime-manager` + `docs-ipc` (37) + `images-ipc` +
  `translate-ipc` + `doctasks-ipc` + `vision-teardown` -> **7 files / 108 tests**. Implementer ran a
  further 5 batches (24 files) green.
- **Discovered -> backlog:** B-14 (status reads still say unlocked mid-teardown), B-15 (now FIXED at
  the composition seam — residual only), B-16, B-17, B-18 (mitigation assigned to Phase 5).

### Phase 5 — AUD-06 + AUD-18 + AUD-20 (hygiene-net & drift coverage) — DONE

Test-only. Three files: `repo-hygiene.test.ts`, `csp-build-output.test.ts`, `script-drift.test.ts`.

**Decision D-5a (widen the filter AND add the root).** Both nets' shared extension filter gained
`sh|ps1|cmd|command`, and `launchers/` was added to both root lists. Verified independently:
`git ls-files | grep -E '\.(sh|ps1|cmd|command|bat)$'` outside the walked roots now returns EMPTY —
**every tracked script and launcher in the repo is inside a net.** A sub-assertion additionally pins
that five named shebang-bearing shipped artifacts are inside the walk, so a future filter narrowing
cannot silently shrink the world the net sees.

**Decision D-5b (the bare-`isUnlocked()` allowlist latch).** The lock-latch phase converted ~15 IPC
modules to `workspaceAdmitsWork()`, and nothing structurally prevented drift back — the
`ipc-lock-coverage` stand-in is `{ isUnlocked: () => false }`, which a bare check satisfies just as
well. New guard enumerates every bare `isUnlocked()` under `src/main/` and pins it against a
12-entry allowlist keyed on **normalised source lines, deliberately not line numbers** (one site
already moved 443 -> 456 mid-wave). It ignores `isUnlocked(): boolean` declarations and pure-comment
lines, and **fails CLOSED on any unrecognised call shape** — teeth-proven with a receiver-less
`const { isUnlocked } = ws` dodge. The failure message states the decision rule verbatim: add to the
allowlist ONLY for a status/lifecycle read; if the site decides whether to DO work, use
`workspaceAdmitsWork`.

**One allowlist entry I did not predict, and it is important:**
`registerWorkspaceIpc.ts :: if (ctx.workspace.isUnlocked()) ctx.workspace.cancelLock()` — the lock
handler's disarm-on-failure path. `workspaceAdmitsWork` would be **WRONG** there: that predicate is
false mid-teardown, so substituting it would skip the disarm and strand the latch armed for the rest
of the session. The allowlist comment records exactly that, which is the single most useful line in
the guard.

- **RED evidence — 10 teeth checks, each planted then removed:**
  - T1 BOM net: a BOM'd `launchers/*.command` + `scripts/*.sh` -> both listed as offenders; the other
    13 repo-hygiene tests stayed green.
  - T2 NUL nets: a NUL-bearing `scripts/*.ps1` and `launchers/*.cmd` -> 2 failed / 12 passed.
  - T3 AUD-18 CI control: real `out/renderer/{index,ocr}.html` moved aside. **Under `CI=1`:**
    `expected false to be true`. **With CI unset: the pre-fix degradation reproduced verbatim** —
    `1 passed | 4 skipped`, i.e. a silent green skip of both real security assertions.
  - T4 AUD-20: `runtime/llama.cpp/mac` drifted to `/macos` in `build-commercial-drive.sh` -> both new
    `.sh` matrix assertions red.
  - T5: a `Write-Error` appended to `verify-models.ps1` -> red, with the fix instruction in the
    message.
  - T6: an unconditional `rm -f` moved ahead of the size compare in `fetch-models.sh` ->
    `expected 66 to be greater than 196` (the delete escaped its guard).
  - T7: the size argument dropped from a `fetch-models.ps1` call site -> `argument count: expected 7
    to be 8`. **This is the one that catches the silent fail-open regression (B-10).**
  - T8: a size test inserted before the OCR delete in `fetch-runtime.sh` -> red, "do not harmonize it
    with the size-guarded fetch-models delete" — the deliberate asymmetry is now defended.
  - T9/T10: the `isUnlocked()` allowlist, drift-back and fail-closed shapes.
- **GREEN over the real tree:** no widened net caught any pre-existing offender. Byte-verified
  beforehand: all 4 launchers and all 14 `scripts/*.{sh,ps1}` start clean.
- **Orchestrator's own gate:** typecheck green; `repo-hygiene` 14 ok, `csp-build-output` 7 ok (1
  pre-existing skip), `script-drift` 29 ok -> **3 files / 49 pass + 1 skip**. Tree independently
  re-verified clean: `git status --untracked-files=all` shows ONLY the three test files; no
  teeth/probe/bak artifact anywhere; `launchers/` has exactly its original 4 files; a byte sweep of
  `launchers/` + `scripts/` reports zero NUL/BOM offenders.
- **Process note (honest record):** the implementer's FIRST teeth round used a relative-path cleanup
  together with a `cd`, so the trap's `rm -f` resolved against the wrong directory and left 2 BOM'd
  files in the tree for ~10 s. It caught this on the next run, removed them with absolute paths, and
  switched every subsequent round to absolute-path scripts under `trap ... EXIT INT TERM`. Nothing
  was ever staged or committed; the orchestrator re-verified the tree independently afterwards.
- **AUD-18 was under-specified and the implementer closed the other half.** `built =
  PAGES.every(existsSync(...))` notices pages that DISAPPEAR but not pages that are ADDED: a new
  renderer entry point would leave `built` true, every assertion green, and that page's baked CSP
  never inspected — an unverified packaged policy on a real window. Closed with a page-set pin
  ("PAGES covers every HTML page the renderer build emitted"), teeth-verified with an unlisted page.
- **Discovered -> backlog:** B-19, B-20, B-21, B-22.
- **Handoff to Phase 10:** the allowlist keys on source lines, so if a later phase edits any of the
  12 lines (or adds/removes a site) the guard reddens at that point — that is the intended review
  gate, not a bug. **Phase 10 must re-run `repo-hygiene.test.ts` after every phase has landed** and
  update the allowlist only if the tree legitimately moved.

### Phase 8 — AUD-07 + AUD-21 + AUD-22 + AUD-23 (documentation reconciliation) — DONE

**Decision D-8a (supersede, never rewrite a dated record).** Dated design records are historical
snapshots. The R-O2 research-gate row and the OCR-R deferral each keep their original text with an
appended **dated superseding note**; only present-tense *guidance* (`known-limitations.md`,
`packaging.md`, `troubleshooting.md`) was rewritten. This is the OCR-R "docs truth" precedent, and
the matching idiom already used in `security-model.md`.

**Finding — the "item 15(b) vs 16(b)" ambiguity resolves to 15(b), and only 15(b).** Item 16(b) (the
DEP-1 register's packaged-OCR *fix bundle*) was already accurate and needed no change. Item 15(b)
(the OCR-R register's packaged-OCR *smoke*) said "run the full OCR smoke flow on an asset-carrying
drive before the next release" — active, imperative, now-wrong advice: that deferral **fired** on
2026-07-19 and the answer was an app-killing crash. It now carries a superseding note. The
implementer also found the same stale instruction in the **durable ledger 15(b) points at**
(`architecture.md`, OCR-R remediation ledger, registered deferral 2) and gave it the matching note —
otherwise 15(b) would have been corrected while its own citation target kept the wrong instruction.
That is the kind of second-order consistency this phase existed to get right.

**Two stale surfaces beyond the four the finding named, both fixed:** `packaging.md`'s
draft→smoke→publish release ritual still listed "plus an OCR run" in the stated minimum (removed,
with a dated parenthetical saying why and that it is not a gate again until the fix lands); and
`troubleshooting.md` had nothing at all for a user whose app vanishes — it now says "if the app
closes itself the moment OCR starts, that is a known packaging defect, not your drive", which is the
page a real user actually reaches after the crash.

- **AUD-21 (the four broken links):** RED — `expected [ …(4) ] to deeply equal []`, received the four
  `docs/rag-design.md` x3 + `docs/benchmark.md` targets resolving to non-existent `docs/docs/…`
  paths. GREEN after: **181 relative links across 19 `docs/*.md` files, 0 broken.** The pre-existing
  build-log pin stayed green throughout — i.e. the old net demonstrably could not see this class.
  Link TEXT left byte-identical (the DOC-1 precedent of not touching prose). **No other broken link
  was found, nothing was allowlisted, and the check was not weakened.**
- **AUD-23 (README census) — re-derived independently and it matches:** 20 `download:` blocks under
  `model-manifests/chat/` vs 18 README rows; the two missing were exactly the Qwen3.5 0.8B Q6_K and
  2B UD-Q4_K_XL. Now 20 vs 20. Wider census for completeness: 23 chat manifests total, 3 of which
  carry no `download:` block and are therefore correctly absent from a *downloadable* table; 25
  `download:` blocks repo-wide = 20 chat + 5 non-chat, and all 5 non-chat already appear in the
  README's supporting-models table. Verdict notes are honest per the `model-policy.md` precedent: the
  0.8B is the *surviving* fast-tier candidate, the **2B FAILED** its bar and "should not be
  recommended anywhere".
- **A consequential catch:** the two new rows would have falsified the table's own intro prose
  ("the Min RAM column is each model's lower hard floor"), because the two fast-tier manifests
  deliberately carry the 4B's tier-aligned RAM line rather than a measured floor so they cannot
  hijack the <=12 GB recommendation. The prose now says so, and the Qwen3 4B row's "smallest" became
  "smallest *ranked* model". Adding a row correctly and leaving the surrounding sentence false would
  have been a worse outcome than not adding it.
- **Files:** `docs/architecture.md`, `docs/known-limitations.md`, `docs/packaging.md`,
  `docs/troubleshooting.md`, `docs/data-contracts.md`, `README.md`, `model-manifests/README.md`,
  `BUILD_STATE.md` (§5 item 15(b) note only), `apps/desktop/electron-builder.yml` (comment),
  `apps/desktop/tests/integration/repo-hygiene.test.ts` (link-check extension only — the concurrent
  phase's widened NUL/BOM nets, CSP control and `isUnlocked()` allowlist untouched).
- **Orchestrator's own gate:** `repo-hygiene` 15 ok + `committed-catalog` 17 ok -> **2 files / 32
  tests pass**; all nine touched non-test files verified NUL-free and BOM-free.
- **THE DEFECT ITSELF IS UNTOUCHED AND STILL LIVE:** `electron-builder.yml`'s `asarUnpack` list still
  contains only `tesseract.js` + `tesseract.js-core`, so packaged OCR still crashes. Every change
  here documents a verified reality; the actual repair remains the registered fix bundle.
- **Orchestrator error caught by this phase:** its final typecheck run surfaced 3 errors in
  `db.ts` — the orchestrator's own schema-comment rider had used backticks INSIDE the `SCHEMA`
  template literal, terminating it early. Fixed immediately (backticks removed, with a note in the
  comment saying why they cannot appear there); typecheck re-verified clean. Worth recording: a
  concurrent agent caught an orchestrator mistake that the phase's own gate would not have.
- **Discovered -> backlog:** B-25, B-26, B-27, B-28, B-29, B-30 (**owner decision**), B-31.
