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
