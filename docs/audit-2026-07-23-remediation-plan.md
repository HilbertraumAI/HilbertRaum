# Remediation plan — full audit 2026-07-23

Executable, orchestrated plan to fix every finding in
[`docs/audit-report-2026-07-23.md`](audit-report-2026-07-23.md) (AUD-01…AUD-26 + DV-1…DV-4).
Designed so **Opus acts as the orchestrator**: each phase is implemented by one or more spawned
sub-agents, verified by the orchestrator, committed, and its outcome + any newly-discovered issues
recorded in a **shared handoff ledger** that later phases read. The final phase re-tests everything
and **loops new remediation phases until green**.

> This is a working paper. It is not the durable record — at wave close it is folded into
> `architecture.md` (a §-numbered remediation ledger) and deleted, per the CLAUDE.md doc-lifecycle
> rule. Keep it and the companion ledger **NUL/BOM-free UTF-8** (`repo-hygiene.test.ts` walks
> `docs/` on the filesystem).

---

## 0. How to run this plan (orchestration protocol)

**Roles.**
- **Orchestrator = Opus (this session).** Owns git, the ledger, verification gates, the eyeball
  sign-offs, and the loop. Spawns sub-agents; never lets a sub-agent commit.
- **Implementer sub-agent(s).** Given a precise per-phase brief (the finding text from the audit
  report + the phase spec here + the ledger's carry-forward section). They edit code, write RED→GREEN
  tests, update docs, and return a **structured result** (schema in §0.4). They do **not** run the
  full suite and do **not** commit.
- **Verifier sub-agent (optional, used on the high-risk phases).** Fresh context; adversarially
  re-derives the fix from the diff and confirms the RED→GREEN evidence and that no regression was
  introduced.

**Per-phase loop (the orchestrator runs this for every phase P):**
1. **Read** the ledger's carry-forward backlog; pull any item assigned to P.
2. **Spawn** the implementer(s) with the brief. Sub-agents run in the background by default; wait for
   completion. Run independent phases' agents concurrently **only** when their file sets are disjoint
   (see §0.3) — otherwise sequential.
3. **Verify** (orchestrator does this itself, or spawns the verifier for high-risk phases):
   read the diff; confirm the characterization test was RED before the fix and is GREEN after; run
   the phase's **affected test files** (not the full suite) with the weak-box command in §0.2; confirm
   `typecheck` passes; confirm docs updated. For design phases, do the **eyeball** (§0.5).
4. **If the gate fails:** re-brief the same sub-agent with the exact failure and loop step 2–3. Do
   not commit a red phase.
5. **Commit** (orchestrator only): stage the **explicit files** this phase touched (never
   `git add -A` — the working tree is shared with other sessions), one commit per phase referencing
   the phase id and the AUD ids. Update `BUILD_STATE.md` with a short wave entry in the same commit.
6. **Record** in the ledger: phase outcome, gate numbers, files, decisions, and **every
   newly-discovered issue** → the carry-forward backlog (assign to a later phase or a new remediation
   sub-phase).

**Branch & commit discipline (CLAUDE.md + audit-wave convention).**
- We are on `master` and **must not commit to it.** Phase 0 creates **one** wave branch
  `fix/audit-2026-07-23-remediation`. **One commit per phase.** **Single PR at close** with green
  `ci-success`.
- Stage explicit files only (concurrent sessions share this tree). Never `git add -A`, never
  `git checkout -- .`.
- End every commit message with the `Co-Authored-By: Claude …` trailer.

**Definition of a phase "done":** affected tests green (RED→GREEN evidence captured) · `typecheck`
green · app still builds (for phases touching `src`) · affected docs updated · `BUILD_STATE.md` wave
entry added · ledger updated · committed. (This is the CLAUDE.md per-phase ritual, enforced per
phase.)

### 0.1 Machine profile (checked 2026-07-23)

- **CPU** i7-1185G7, 8 logical cores. **RAM** 17 GB total, **~3 GB free under load** — treat RAM as
  the binding constraint.
- **Prepared drive** (real weights + runtime) is mounted at **`D:\`** today; the user may mount it as
  **`F:\`** — resolve the drive letter at run time (§0.6). Weights are real multi-GB GGUFs; **the
  `llama-server.exe` under `runtime/llama.cpp/win/` is a 9 KB stub on D:** — real e2e needs the true
  binary (see §0.6, Phase 10-E2E gates on it).

### 0.2 Weak-box test discipline (mandatory)

- **Per phase:** run only the affected test files:
  `cd apps/desktop && npx vitest run <path1> <path2>` (clear `ELECTRON_RUN_AS_NODE` first — see
  §0.6). Never the full suite mid-wave.
- **Typecheck** is cheap: `npm run typecheck` (root) or `cd apps/desktop && npm run typecheck`.
- **Full suite** runs **once**, in Phase 10, capped: `cd apps/desktop && npx vitest run --maxWorkers=4`
  (RAM-bound; drop to `--maxWorkers=2` if the box is loaded). **Never `test:coverage`** (DEP-1 §5(c):
  full-width coverage starves this box).
- **Build** check when `src` changed: `npm run build` (root).
- Close the dev app and any stray Electron/node before the full suite or any e2e (free the ~10+ GB the
  app holds).

### 0.3 Parallelism map (which phases may run concurrently)

Default is **sequential single-branch commits.** These phases have **disjoint file sets** and MAY be
run in parallel via worktree-isolated sub-agents if the orchestrator wants to accelerate (integrate
results back onto the wave branch one at a time, then commit in phase order):

- **Phase 4** (scripts only: `scripts/*.ps1`, `scripts/*.sh`)
- **Phase 5** (test files only: `tests/integration/repo-hygiene.test.ts`, `csp-build-output.test.ts`,
  `script-drift.test.ts`)
- **Phase 8** (docs only: `docs/*.md`, `README.md`, `model-manifests/README.md`,
  `apps/desktop/electron-builder.yml` comment)

Everything else touches overlapping `apps/desktop/src` files or the EP-1 surface and runs
**sequentially**. **Phases 1, 2, 6, 7 must be sequential** (1→2 both touch the workspace/chat main
path; 6→7 both touch the EP-1 surface). Given the RAM ceiling, prefer **one implementer agent at a
time** unless you deliberately isolate with worktrees.

### 0.4 Sub-agent result schema (implementers return this)

```
{
  phase: "<id>",
  aud_ids: ["AUD-nn", ...],
  files_changed: ["repo/relative/path", ...],           // exact, for explicit staging
  tests: {
    added: ["test/path::test name", ...],
    red_evidence: "<how the new test failed BEFORE the fix — paste the failing assertion/output>",
    green_evidence: "<the affected-file run output AFTER the fix: N passed>",
    command: "<the exact vitest command run>"
  },
  docs_updated: ["docs/x.md §y", ...],
  design_eval: { screenshots: [...], checklist: {...} } | null,   // Phase 9 / design only
  discovered_issues: [ { summary, location, severity, suggested_phase } ],  // → ledger backlog
  residuals: "<anything deliberately left, with rationale>",
  self_gate: { typecheck: "pass|fail", affected_tests: "pass|fail" }
}
```

### 0.5 Design evaluation with eyeball (Phase 9, DV-1/DV-2)

Design changes are not "done" on green tests — they require a **visual sign-off by the orchestrator
(Opus), who can view images**. Procedure:
1. The implementer captures **before** and **after** PNGs of the affected screen in **both themes**
   using the CDP harness pattern (launch dev app with `ELECTRON_RUN_AS_NODE` cleared +
   `--remote-debugging-port`, drive the real in-app theme control, `Page.captureScreenshot`). Store in
   the scratchpad (not committed).
2. The orchestrator **opens the PNGs** and checks them against the per-change eyeball checklist
   (DV-1: select uses `--font-sans`, `--radius-sm`, `--border-strong`, `--surface` in both themes;
   DV-2: runnable/ranked models appear first when no recommendation exists). Computed-style probes
   (`getComputedStyle`) back the eyeball with numbers.
3. Record **pass/fail + the screenshot paths** in the ledger. A failed eyeball loops the phase.

### 0.6 Environment gotchas

- **`ELECTRON_RUN_AS_NODE`**: Claude's shells inherit `ELECTRON_RUN_AS_NODE=1`; **clear it** before
  any Electron launch (`env -u ELECTRON_RUN_AS_NODE …` in bash, or
  `cmd /c "set ELECTRON_RUN_AS_NODE=&& …"`) or the app dies with a fake ESM error. (vitest runs under
  system Node and is unaffected.)
- **Drive letter**: resolve at run time — check `D:\config\drive.json` then `F:\config\drive.json`;
  export `HILBERTRAUM_LLAMA_BIN=<root>/runtime/llama.cpp/win/llama-server.exe` and
  `SKILLS_SMOKE_MODEL=<root>/models/chat/qwen3-4b-instruct-2507-q4.gguf` (the 2.5 GB smallest weight)
  for e2e.

### 0.7 Reference hygiene — transient working papers (no durable references)

These files are **transient** and will be deleted at wave close (or shortly after, by the owner). No
**durable** artifact may reference any of them by path or filename:

- `docs/audit-report-2026-07-23.md` (the audit report)
- `docs/audit-2026-07-23-remediation-plan.md` (this plan)
- `docs/audit-2026-07-23-remediation-ledger.md` (the ledger)
- `apps/desktop/tests/integration/invoice-audit-ia1.test.ts` (owner-retired — treat as already gone;
  do not cite it, do not model new tests on a citation to it)

**Durable artifacts** = committed code comments, test names/comments, `BUILD_STATE.md` entries,
`CHANGELOG.md`, committed docs, and the `architecture.md` close-out ledger. Rules:

- In code/test comments and commit messages, describe the fix **self-containedly**. Do not write
  "see `audit-report-2026-07-23.md`" or "per the remediation plan §X". If you need an anchor, cite the
  durable `architecture.md` close-out section (created in Phase 11) or a bare `AUD-nn` **label whose
  full meaning is restated in that self-contained ledger table** — the label resolves there, never to
  the deleted report.
- `BUILD_STATE.md` wave entries: record outcome + a durable pointer (the `architecture.md` ledger
  section / a commit sha), not the working-paper filenames.
- The `architecture.md` close-out ledger must be **self-contained** (re-state each finding +
  disposition, per the §46–§50 precedent). Its §-anchor legend may note that the working papers' full
  text lives in the **wave-open commit** (git history) — as prose, without a live link.
- The plan, ledger, and report MAY reference each other (they are transient together); that is not a
  durable reference and needs no cleanup.

---

## 1. Handoff ledger (cross-phase information transfer)

Phase 0 creates **`docs/audit-2026-07-23-remediation-ledger.md`** (a working paper, uncommitted,
NUL/BOM-clean). Every phase **reads** it at start and the orchestrator **appends** to it at end. It is
the single channel for carrying discoveries, decisions, and residuals between phases (and across
sessions, since it is on disk). At wave close it is folded into the durable `architecture.md` record
and deleted.

**Ledger template (Phase 0 writes this skeleton):**

```markdown
# Remediation ledger — audit 2026-07-23 wave

Branch: fix/audit-2026-07-23-remediation
Baseline: <sha> · suite <N>/<skip> · typecheck <ok> · build <ok>
Machine: i7-1185G7 / 8c / 17GB (see plan §0.1)

## Carry-forward backlog (issues found mid-wave; each assigned to a phase)
- [ ] (empty at start)

## Decisions log
- (append owner/orchestrator decisions here)

## Phase outcomes
### Phase 0 — setup — <status>
- branch created, baseline gate: <numbers>
### Phase 1 — AUD-01 — <status>
- commit <sha> · files <...> · tests RED→GREEN <...> · gate <...>
- discovered: <...> → backlog
...
```

**Backlog protocol.** When a sub-agent's `discovered_issues` names something out of the current
phase's scope, the orchestrator adds it to the backlog with a `suggested_phase`. If it blocks the
current fix, it is handled now; otherwise it is scheduled — either into an existing later phase or into
a **new remediation sub-phase** created by Phase 10's loop. Nothing discovered is silently dropped.

---

## 2. Phase catalog

Each phase: **Goal · AUD ids · Blast-radius reconfirmation · Files · Sub-agents · Steps · Tests ·
Docs · Acceptance gate · Handoff outputs · Rollback.** "Blast-radius reconfirmation" is a hard
gate: the implementer must first write a **characterization test that reproduces the exact failure
(RED)** before changing code, so the blast radius is proven empirically, not assumed.

---

### Phase 0 — Wave setup & baseline (orchestrator, no sub-agent)

- **Goal:** clean branch, ledger, and a green baseline so every later phase's gate is meaningful.
- **Steps:**
  1. From `master` (pull latest if a remote is reachable), create `fix/audit-2026-07-23-remediation`.
  2. Write the ledger skeleton (§1) to `docs/audit-2026-07-23-remediation-ledger.md`.
  3. Baseline gate: `cd apps/desktop && npm run typecheck` (green) + a fast smoke of the areas the
     wave touches: `npx vitest run tests/integration/repo-hygiene.test.ts` and a lightweight
     collection check (`npx vitest run --reporter=dot tests/unit`), recording counts. Full suite is
     NOT required here (Phase 10 owns it) — just confirm typecheck + a representative subset are green
     so a later red is attributable to the wave.
  4. Record machine profile + baseline numbers in the ledger.
- **Acceptance:** branch exists; ledger exists and is NUL/BOM-clean; typecheck green.
- **Handoff:** baseline sha + numbers in the ledger.
- **Rollback:** delete the branch.

---

### Phase 1 — AUD-01: evidence-review data-loss guard  ⟨priority: do first⟩

- **AUD ids:** AUD-01 (Medium, data-loss; High-arguable).
- **Goal:** the documents-channel "Answer without it" undo can never silently destroy an evidence
  review; the failure paths (F2 restore, CB-2 Stop) preserve it too.
- **Blast-radius reconfirmation (RED first):** an integration test — documents conversation →
  skill-stamped answer → create a review with a decision/note (+ optionally an export row) → click the
  regenerate/undo path → assert (pre-fix) that `getEvidenceReviewForMessage` returns `null` and the
  `evidence_reviews`/`_items`/`_links`/`_exports` counts drop to 0. This proves the cascade before the
  fix. Second RED test: force a non-abort regenerate failure and assert the review is gone even though
  the answer is restored.
- **Files:** `apps/desktop/src/main/services/chat.ts` (deleteLastAssistantMessage /
  withRegenerateGuard seam), `apps/desktop/src/main/ipc/chat-stream.ts`,
  `apps/desktop/src/main/ipc/registerRagIpc.ts`, `apps/desktop/src/main/services/evidence-reviews.ts`
  (add a `hasReviewForMessage`/count helper), `apps/desktop/src/renderer/chat/Transcript.tsx`,
  `apps/desktop/src/renderer/screens/ChatScreen.tsx`; i18n `shared/i18n/{en,de}.ts`.
- **Sub-agents:** 1 implementer (main-side + renderer) + **1 verifier** (this is the data-loss
  finding — adversarially confirm the guard cannot be bypassed by any caller, incl. the chat channel,
  and that both restore paths now preserve the review).
- **Steps:**
  1. Main-side gate (airtight; regenerate=true is caller-supplied over IPC): in the
     `withRegenerateGuard` delete path, if the target message has a review, **refuse** with a localized
     `main.chat.reviewBlocksRegenerate`-class message (mirror the D-2 conversation-delete posture).
     Cover the chat channel defensively.
  2. Renderer: hide or confirm the "Answer without it" affordance when `reviewSummaries` has an entry
     for that message (`Transcript.tsx:361` — add the review check to `canUndo`).
  3. EN+DE copy for the refusal/confirm.
- **Tests:** the two RED integration tests above → GREEN after; a renderer test that the undo is
  hidden/confirmed when a review exists. Run:
  `npx vitest run tests/integration/<new> tests/renderer/<new> tests/integration/rag-regenerate-ipc.test.ts tests/integration/chat-stream-regenerate.test.ts`.
- **Docs:** EP-1 record `architecture.md` §2/§8 (the guarded interaction); user-guide review section;
  `known-limitations.md` only if a residual remains.
- **Acceptance gate:** both RED tests now GREEN; the undo cannot delete a reviewed answer from any
  channel; verifier signs off; typecheck + affected tests green; docs updated.
- **Handoff:** the new `hasReviewForMessage` helper signature (Phase 6 may reuse it); note whether the
  chosen fix is refuse-vs-confirm (decision → ledger).
- **Rollback:** the guard is additive; revert the guard commit.

---

### Phase 2 — AUD-02 + AUD-03: lock-in-progress latch  ⟨do second⟩

- **AUD ids:** AUD-02, AUD-03 (both Medium). One shared latch fixes both (and covers the accepted
  CODE-2 residual class).
- **Goal:** once "Lock now" begins, nothing user-derived starts or respawns; the background model
  auto-start cannot spawn `llama-server` after the lock.
- **Blast-radius reconfirmation (RED first):** (a) integration test driving `IPC.lockWorkspace` with a
  **deferred/gated** sidecar suspend; issue `startDocTask('translation')` / `translateStart` /
  `imageAnalyze` while the handler is parked in its awaited teardown; assert (pre-fix) each is admitted
  and a `translate()`/`createRuntime` fires. (b) core-model-ipc test: gate `computeInstallState`
  (injectable hash store), run `maybeAutoStartActiveModel`, complete a lock while the hash is parked,
  release it, assert (pre-fix) `runtime.start` **was** invoked.
- **Files:** `apps/desktop/src/main/services/workspace-vault.ts` (add `beginLock()` / `isLocking()`),
  `apps/desktop/src/main/ipc/registerWorkspaceIpc.ts` (arm the latch first),
  `registerDocTasksIpc.ts`, `services/doctasks/manager.ts` (`startDocTask`),
  `registerTranslateIpc.ts` / `services/translation/jobs.ts` (`start`),
  `registerImagesIpc.ts` / `services/vision/index.ts` (`analyze`), `registerDocsIpc.ts` (import loop),
  `registerModelIpc.ts` (`startModelRuntime` re-check after `computeInstallState`),
  `services/runtime/index.ts` if an unlock-epoch is used.
- **Sub-agents:** 1 implementer (+ **1 verifier** — the latch touches every content surface; confirm
  each guard consults it and none was missed, and that unlock clears it).
- **Steps:**
  1. `beginLock()` arms an `isLocking` flag as the lock handler's **first** act; cleared only on lock
     failure (and by a completed lock, since `isUnlocked()` then reports locked anyway).
  2. Route every content-surface admission guard + `startModelRuntime`'s post-hash re-check through
     `isUnlocked() && !isLocking()`.
  3. Optional: capture an unlock epoch at auto-start entry to close the residual micro-window.
- **Tests:** the two RED tests → GREEN (fresh admissions refused during teardown; no `runtime.start`
  after a lock parked on the hash). Run the new files +
  `tests/integration/workspace-ipc.test.ts tests/integration/core-model-ipc.test.ts tests/integration/runtime-manager.test.ts`.
- **Docs:** `security-model.md` lock section; reconcile `architecture.md:2876` ("sidecars only start
  post-unlock" — now true); the GPU record §5.6 note if touched.
- **Acceptance gate:** both races fail closed; existing lock/unlock tests stay green; verifier confirms
  full guard coverage; typecheck + affected tests green; docs updated.
- **Handoff:** the `isLocking()` API (any future content surface must consult it → note in the ledger
  decisions log so later phases adding IPC do the same).
- **Rollback:** the latch is additive; revert.

---

### Phase 3 — AUD-04: Translate adopt terminal-clobber / foreign-task hijack

- **AUD ids:** AUD-04 (Medium).
- **Goal:** `adoptActiveFileTranslation` honours its documented terminal-no-op and reload-only scope.
- **Blast-radius reconfirmation (RED first):** unit test — seed the store to `state:'done'` with
  output, stub `getActiveDocTask` to a running translation, call `adoptActiveFileTranslation`, assert
  (pre-fix) the snapshot was clobbered. Second RED: idle store + a foreign task tracked by
  `lib/doctasks`, assert (pre-fix) it was adopted.
- **Files:** `apps/desktop/src/renderer/lib/fileTranslateSession.ts:492,500-513`;
  `apps/desktop/tests/renderer/fileTranslateSession.test.ts`.
- **Sub-agents:** 1 implementer (renderer-only, self-contained).
- **Steps:** change the guard to `if (snapshot.state !== 'idle') return`; add the foreign-task check
  (`const g = getActiveDocTask(); if (g && g.jobId === task.jobId && !isDocTaskTerminal(g.status)) return`,
  mirroring `guardStart`).
- **Tests:** the two RED cases → GREEN; run
  `npx vitest run tests/renderer/fileTranslateSession.test.ts tests/renderer/TranslateScreen.test.tsx`.
- **Docs:** none (behaviour now matches the FA-3 record); note in `known-limitations.md` only if a
  residual remains.
- **Acceptance gate:** a held done result and a Documents-row translation both survive navigation;
  affected tests green.
- **Handoff:** none expected.
- **Rollback:** revert the guard.

---

### Phase 4 — AUD-05 + AUD-24: provisioning-script robustness  ⟨independent — parallelizable⟩

- **AUD ids:** AUD-05 (Medium), AUD-24 (Low).
- **Goal:** the `.ps1` best-effort/continue paths behave like the canonical `.sh` siblings; the
  mismatch redo path deletes before re-downloading.
- **Blast-radius reconfirmation:** reproduce on the real host (PS 5.1, `powershell.exe -File`) — a
  scratch script with the OCR-loop pattern under `$ErrorActionPreference='Stop'` aborts at the first
  `Write-Error`; the parent `& $child` invocation is killed before its tolerant `$LASTEXITCODE`
  branch. (Do this in a temp dir; do not touch the repo scripts to prove it.) Also verify whether
  `runtime-sources.yaml`'s whisper win URL is a live release asset or a 404 placeholder.
- **Files:** `scripts/fetch-runtime.ps1`, `scripts/prepare-drive.ps1`, `scripts/fetch-models.ps1`
  (and `.sh` siblings only if parity edits are needed); optionally `tests/integration/script-drift.test.ts`.
- **Sub-agents:** 1 implementer (scripts). May run in a worktree in parallel with Phases 5/8.
- **Steps:** replace tolerant-path `Write-Error` with `Write-Host -ForegroundColor Red` + explicit
  `exit` (the pattern already used at ps1 `:332`/`:434`); restore the documented `exit 2` codes; wrap
  `prepare-drive`'s `&` child invocations in `try/catch`; add delete-before-redo in the fetch-models
  mismatch path.
- **Tests:** manual repro (documented in the ledger, not a CI test) that `-Family ocr` now attempts
  all files after a first failure, and `-WithAssets` warns-and-continues on a whisper miss. Optional:
  a `script-drift.test.ts` behaviour/string-parity guard. Run any touched test file.
- **Docs:** `troubleshooting.md`/`packaging.md` only if the DIY guidance references the old behaviour;
  otherwise none.
- **Acceptance gate:** the two manual repros show warn-and-continue; exit codes restored; `.sh`/`.ps1`
  parity holds.
- **Handoff:** the whisper-URL live/placeholder finding → ledger (may spawn a follow-up if the URL is
  dead).
- **Rollback:** script-local; revert.

---

### Phase 5 — AUD-06 + AUD-18 + AUD-20: hygiene-net & drift-test coverage  ⟨independent — parallelizable⟩

- **AUD ids:** AUD-06 (Medium), AUD-18 (Low), AUD-20 (Low).
- **Goal:** the shipped byte-0-sensitive artifacts (launchers, shell scripts) and the packaged-CSP
  guard are actually enforced; the `.sh` runtime matrix is drift-guarded.
- **Blast-radius reconfirmation (RED first):** plant a BOM'd copy of a launcher and a `.sh` script in a
  temp dir wired into the net's walk; assert (pre-fix) the net does NOT catch it. For AUD-18, simulate
  a missing build output and assert (pre-fix) the CSP guard skips green with no failure.
- **Files:** `apps/desktop/tests/integration/repo-hygiene.test.ts` (extend the extension filter +
  root list), `apps/desktop/tests/integration/csp-build-output.test.ts` (CODE-46 CI positive control),
  `apps/desktop/tests/integration/script-drift.test.ts` (`.sh` matrix).
- **Sub-agents:** 1 implementer (test-only). May run in a worktree in parallel with Phases 4/8.
- **Steps:** add `sh|ps1|cmd|command` to both nets' shared extension filter and `launchers/` to both
  root lists; add `it('guard ran on CI', () => { if (process.env.CI) expect(built).toBe(true) })` to
  the CSP guard; extend `script-drift` to parse+compare `build-commercial-drive.sh`'s matrix.
- **Tests:** teeth ritual — planted BOM/NUL files reddens the widened net, then remove; the CSP CI
  control reddens when `built` is false under `CI=1`. Also confirm the widened net stays green over
  the **real** tree (all launchers/scripts are currently clean — verified in the audit). Run
  `npx vitest run tests/integration/repo-hygiene.test.ts tests/integration/csp-build-output.test.ts tests/integration/script-drift.test.ts`.
- **Docs:** none.
- **Acceptance gate:** widened nets green over the real tree AND red on planted offenders; CSP CI
  control present; `.sh` matrix guarded.
- **Handoff:** if the widened net catches any real pre-existing offender (unexpected), → backlog.
- **Rollback:** test-only; revert.

---

### Phase 6 — AUD-12 + AUD-13 + AUD-14 + AUD-15: evidence-review performance

- **AUD ids:** AUD-12, AUD-13, AUD-14, AUD-15 (all Low; AUD-12 the most worthwhile).
- **Goal:** remove the O(N) per-conversation-open IPC fan-out, the per-item bulk fan-out, the sync
  export stall, and the missing index.
- **Blast-radius reconfirmation:** (12) spy the IPC channel and assert (pre-fix) N round-trips for an
  N-message conversation open; (13) assert (pre-fix) N writes + N lock re-reads for a bulk action;
  (14) EQP shows SCAN (pre-fix) on the delete-confirm COUNT; (15) assert (pre-fix) the export tail
  uses `*Sync` on the main thread.
- **Files:** `apps/desktop/src/main/ipc/registerEvidenceReviewsIpc.ts`,
  `apps/desktop/src/main/services/evidence-reviews.ts`,
  `apps/desktop/src/renderer/screens/ChatScreen.tsx`,
  `apps/desktop/src/renderer/lib/reviewSession.ts`,
  `apps/desktop/src/main/services/evidence-pack/export.ts`, `.../print-pdf.ts`,
  `apps/desktop/src/main/services/db.ts` (additive index).
- **Sub-agents:** 1 implementer. **Sequential with Phase 7** (both EP-1). If a `hasReviewForMessage`
  helper landed in Phase 1, reuse it (check the ledger).
- **Steps:** add a batch `getEvidenceReviewSummariesForConversation(convId)`; batch the three bulk
  actions into one transaction; port the export fs tail to async (`fs.promises` + fsync via a handle,
  preserving the atomic tmp→fsync→hash→rename contract); add
  `idx_evidence_reviews_conversation ON evidence_reviews(conversation_id)`.
- **Tests:** RED→GREEN round-trip-count assertions (12/13), the EQP SEARCH assertion (14, matching the
  TS-5 index-name idiom), and an assertion that the export tail is off the main thread / no `*Sync`
  (15). Run `npx vitest run tests/integration/evidence-reviews-ipc.test.ts tests/integration/evidence-pack-export.test.ts` + any new files.
- **Docs:** the EP-1/perf record in `architecture.md`; `data-contracts.md` if the new batch channel
  changes a shape.
- **Acceptance gate:** one round-trip per conversation open; bulk action one transaction; export off
  the main thread; EQP SEARCH; affected tests green.
- **Handoff:** the batch channel name/shape → Phase 7 (if its tests assume round-trip counts) and the
  docs phase.
- **Rollback:** per-change; each is independent.

---

### Phase 7 — AUD-08 + AUD-16 + AUD-17 + AUD-09 + AUD-10 + AUD-11: evidence-pack & review-UI polish

- **AUD ids:** AUD-08, AUD-16, AUD-17 (source-context/PDF reliability), AUD-09, AUD-10, AUD-11
  (review-UI a11y/i18n). All Low.
- **Goal:** correct the source-context double-render, the swallowed cleanup, the concurrent-export
  swap, and the three review-UI a11y/i18n nits.
- **Blast-radius reconfirmation:** (08) reproduce the ~450-char duplicated run with the real chunker on
  a two-adjacent-chunk join; (16) reproduce the swallowed unlink on a held-handle file (temp dir);
  (17) reproduce the concurrent-export content swap on installed Electron 39 (temp dir, 12/12 shape);
  (09/10/11) assert the current wrong a11y/i18n state in renderer tests.
- **Files:** `apps/desktop/src/main/services/evidence-pack/source-context.ts`, `.../print-pdf.ts`
  (+ import a logger; per-export unique print-source path incl. packId),
  `apps/desktop/src/renderer/review/{ReviewSummaryView,EvidencePane}.tsx`,
  `apps/desktop/src/renderer/screens/ReviewScreen.tsx`, i18n `shared/i18n/{en,de}.ts`,
  `docs/security-model.md:381`.
- **Sub-agents:** 1–2 implementers — **may split** into (7a) backend export reliability
  (08/16/17) and (7b) renderer a11y/i18n (09/10/11) since the file sets are disjoint; if split, run
  7a then 7b sequentially (both are small) or in two worktrees.
- **Steps:** de-overlap on chunk join (drop the shared prefix run); `log.warn` (ids-only) + one retry
  in the print-source cleanup catch; per-export unique print-source path (or serialise on the shared
  source); reset the disclosure `aria-expanded` when `exportBlocked` flips true; reset `drawerOpen` on
  leaving narrow mode; add a dedicated `review.evidence.more.one/.other` key pair for source cards.
- **Tests:** RED→GREEN for each: two-adjacent-chunk de-overlap; a cleanup-failure logs-and-retries
  test; a concurrent-export provenance test; the three a11y/i18n reconciliations. Run the review
  renderer suites + `evidence-pack` integration files.
- **Docs:** `security-model.md` residue note (AUD-16); EP-1 record if the export path changes.
- **Acceptance gate:** no duplicated context; cleanup failures logged; concurrent exports cannot swap
  provenance; a11y/i18n corrected; affected tests green.
- **Handoff:** none expected.
- **Rollback:** per-change.

---

### Phase 8 — AUD-07 + AUD-21 + AUD-22 + AUD-23: documentation reconciliation  ⟨independent — parallelizable⟩

- **AUD ids:** AUD-07 (Medium doc), AUD-21, AUD-22, AUD-23 (Low docs).
- **Goal:** docs stop understating the packaged-OCR crash and stop pointing at dead links; the
  manifest README and README chat-model table are complete.
- **Blast-radius reconfirmation:** confirm the current wrong text at each cited line (already verified
  in the audit); confirm the four `data-contracts.md` links resolve to non-existent `docs/docs/…`
  paths.
- **Files:** `docs/known-limitations.md:1908`, `docs/packaging.md:180`, `docs/architecture.md:2426`
  (R-O2 row) + the `apps/desktop/electron-builder.yml:139-143` comment + `BUILD_STATE.md` §5 item
  15(b); `docs/data-contracts.md:205,250,268,303`; `model-manifests/README.md:7`; `README.md:212`;
  and extend the DOC-1 link-check in `repo-hygiene.test.ts` to `docs/*.md` (coordinate with Phase 5 if
  both touch that file — assign the link-check extension to **one** phase; default: Phase 8 owns the
  doc-link extension, Phase 5 owns the NUL/BOM/CSP/drift changes).
- **Sub-agents:** 1 implementer (docs). May run in a worktree in parallel with Phases 4/5.
- **Steps:** AUD-07 — superseding-note the packaged-OCR bullet/paragraph/row/comment to the DEP-1
  §4(c) verified-crash reality + "dev-mode OCR unaffected" (OCR-R "docs truth" precedent). AUD-21 —
  sibling-relative link targets. AUD-22 — add the `translation/` bullet. AUD-23 — add the two Qwen3.5
  rows with honest §9 verdict notes (DOC-3 precedent).
- **Tests:** the extended `docs/*.md` link-check (RED on the four bad links → GREEN after). Run
  `npx vitest run tests/integration/repo-hygiene.test.ts`.
- **Docs:** this phase *is* the docs; also ensure NUL/BOM-clean.
- **Acceptance gate:** packaged-OCR reads as a verified crash + registered fix; zero broken relative
  links in `docs/`; manifest README + README table complete; link-check green.
- **Handoff:** none.
- **Rollback:** docs-only; revert.

---

### Phase 9 — AUD-19 + AUD-25 + AUD-26 + DV-1 + DV-2 (+ optional DV-3): maintainability & design ⟨eyeball required⟩

- **AUD/DV ids:** AUD-19, AUD-25, AUD-26 (Low maintainability); **DV-1, DV-2 (design — eyeball
  required)**; DV-3 optional (known CODE-25 quote residual).
- **Goal:** exhaustiveness tooth on `canonicalCoverage`; prune genuinely-dead exports (keep the
  documented `nodeVectorSearch` fallback); align CI Node/npm to the release + engines floor; style the
  native selects to the tokens; order the model picker runnable-first when no recommendation exists.
- **Sub-agents:** **2** — (9a) maintainability (AUD-19/25/26), (9b) design (DV-1/DV-2 + optional DV-3),
  because 9b must produce screenshots and 9a must not. Run 9a and 9b sequentially (9b needs the dev app
  free of RAM pressure).
- **Steps (9a):** add a `satisfies Record<keyof CoverageInfo, …>` / keys-parity tooth to
  `freshness.ts:80`; prune the confirmed-dead exports (verify each with a repo-wide reference grep
  first; keep `nodeVectorSearch`); bump `.github/workflows/ci.yml` to Node 24 (or matrix incl. 24) +
  `corepack enable` so `npm@11.6.2` runs.
- **Steps (9b):** DV-1 — add a shared `select` treatment (reuse `.review-relation select` rules:
  `--font-sans`, `--radius-sm`, 1px `--border-strong`, `--surface`, `--text`) and apply to the Models
  context-size + Translate language-bar selects. DV-2 — order the picker runnable-first / ranked-first
  when no benchmark recommendation exists (display order only; do not touch `recommendModelIdByRam`).
  Optional DV-3 — fix the Images empty-state `„…"` → `„…“` and sweep the ~7 known ASCII closers.
- **Tests:** 9a — `canonicalCoverage` keys-parity test (RED if a `CoverageInfo` field is added and not
  listed); a dead-export check is optional (don't wire ts-prune into CI here). CI Node bump is
  validated by the next CI run (note in ledger). 9b — a `select` computed-style unit/renderer probe if
  feasible; the picker-order unit test (runnable-first with no recommendation).
- **Design evaluation (mandatory, §0.5):** 9b captures **before/after** PNGs of the Models screen
  (context-size select) and the Translate language bar in **both themes**; the orchestrator opens them
  and checks DV-1 (select font=system, radius=`--radius-sm`, border/bg on-token in both themes) and
  DV-2 (runnable/ranked models first). Record pass/fail + screenshot paths in the ledger. A failed
  eyeball loops 9b.
- **Docs:** `design-guidelines.md` §6 if the shared `select` treatment is codified; note DV-3 closure
  against BUILD_STATE §5 item 11 (CODE-25).
- **Acceptance gate:** 9a tests green; 9b eyeball **passed by the orchestrator in both themes** +
  computed-style probe confirms the tokens; CI Node/npm aligned.
- **Handoff:** the CI Node bump must be observed green on the next CI run (Phase 11 PR) → ledger.
- **Rollback:** per-change; the select styling and picker order are independent.

---

### Phase 10 — Full verification & loop-back  ⟨tests every change; loops until green⟩

- **Goal:** prove the whole wave is coherent and nothing regressed; loop new remediation phases until
  green.
- **Steps:**
  1. Free RAM: close the dev app + stray Electron/node.
  2. **Full gate:** `cd apps/desktop && npm run typecheck` · `npm run build` (root) ·
     `npx vitest run --maxWorkers=4` (drop to `--maxWorkers=2` if RAM-pressured). Record counts vs the
     Phase-0 baseline (expect baseline + exactly the wave's new tests).
  3. **Cross-check the ledger backlog:** every discovered issue is either fixed in a phase or has an
     explicit disposition (fixed / deferred-with-registration / owner-gated). Nothing silently
     dropped.
  4. **Design re-eyeball:** re-capture the two design screens in both themes and confirm the Phase-9
     sign-off still holds against the integrated tree.
  5. **Optional e2e** (see the E2E appendix): only if the real `llama-server` binary is present
     (size check); env-gated; smallest model; app closed. E2e is a **confidence** leg, not the gate —
     a skip (stub binary / no drive) is acceptable and recorded, not a failure.
- **Loop-back:** if any test is red, or a design eyeball fails, or a backlog item is unresolved,
  create a **new remediation sub-phase** `10a`, `10b`, … (each: reproduce → fix RED→GREEN → verify →
  commit → ledger) and re-run the full gate. Repeat until green. If a fix needs an owner decision or
  the same test fails **3 loops running**, **stop and escalate to the user** with the exact failure
  (do not thrash).
- **Acceptance gate:** typecheck green · build green · full suite green (baseline + new tests only) ·
  design eyeball holds · backlog fully dispositioned · e2e passed or explicitly skipped-with-reason.
- **Handoff:** final gate numbers → the close-out record.
- **Rollback:** none (verification); a failing wave stays on the branch, never merged red.

---

### Phase 11 — Wave close-out & PR

- **Goal:** fold the durable record, retire the working papers, open the PR with green CI.
- **Steps:**
  1. Fold a durable per-finding disposition ledger into `architecture.md` as a new §-numbered
     "Full audit (2026-07-23) — remediation ledger + close-out" (the §46–§50 template), with the
     §-anchor legend so `AUD-nn` citations resolve. **It must be self-contained** (§0.7): each row
     restates the finding and its disposition, so nothing depends on the deleted report/plan; the
     legend may point at the wave-open commit in prose, never as a live link.
  2. Archive the wave's `BUILD_STATE.md` dated entries (newest-first) to `docs/build-log.md` per the
     retention rule; keep BUILD_STATE under budget.
  3. **Delete** this plan file and the ledger (`git rm`) after verifying no tracked file references
     them; the full text stays in git history via the wave-open commit.
  4. Open the PR (base `master`), body summarising the wave; wait for green `ci-success` (both OS legs
     + CLA). Do **not** merge without the user's go-ahead.
- **Acceptance gate:** durable record folded; working papers retired with zero dangling references;
  PR open and green.
- **Rollback:** the PR is the reversible unit; nothing is merged without sign-off.

---

## 3. Findings → phase coverage matrix

Every audit id maps to exactly one phase (design ids may recur in eyeball).

| Phase | AUD / DV ids | Severity | Independent? |
|---|---|---|---|
| 1 | AUD-01 | Med (data-loss) | no (main path) |
| 2 | AUD-02, AUD-03 | Med | no (lock path) |
| 3 | AUD-04 | Med | renderer-only |
| 4 | AUD-05, AUD-24 | Med, Low | **yes** (scripts) |
| 5 | AUD-06, AUD-18, AUD-20 | Med, Low, Low | **yes** (tests) |
| 6 | AUD-12, AUD-13, AUD-14, AUD-15 | Low ×4 | no (EP-1) |
| 7 | AUD-08, AUD-16, AUD-17, AUD-09, AUD-10, AUD-11 | Low ×6 | no (EP-1) |
| 8 | AUD-07, AUD-21, AUD-22, AUD-23 | Med, Low ×3 | **yes** (docs) |
| 9 | AUD-19, AUD-25, AUD-26, DV-1, DV-2 (+DV-3 opt) | Low + design | partly |
| 10 | — (verifies all) | — | — |
| 11 | — (close-out) | — | — |

DV-4 (Skills label duplication) is Info/no-action — not scheduled. The two verified-and-dismissed
items (refuted rank-0 sampling; the engine-download-tar-child-on-quit duplicate of BUILD_STATE §5
item 9) are **not** in this wave; the tar-child one is noted in the ledger decisions log as a
confirmed extension of a known residual for a future downloads-teardown wave.

---

## 4. Recommended execution order & dependencies

1. **Phase 0** (setup).
2. **Phase 1** (AUD-01) — alone, first; the only data-loss item.
3. **Phase 2** (AUD-02/03) — the lock latch; makes `architecture.md:2876` true. After 1 (both touch
   the workspace/chat main path).
4. **Phases 3, 4, 5, 8** — independent; may run in parallel (worktrees) or in quick sequence. 4/5/8
   are fully disjoint (scripts / tests / docs); 3 is renderer-only.
5. **Phase 6 → Phase 7** — EP-1 surface, sequential (6 first: its batch IPC channel may be assumed by
   7's tests).
6. **Phase 9** — maintainability + design; 9a then 9b (9b needs the dev app + orchestrator eyeball).
7. **Phase 10** — full verification + loop until green (e2e optional).
8. **Phase 11** — close-out + PR (no merge without user go-ahead).

**Hard dependencies:** 1→2 (main path coherence); 6→7 (batch channel); 9 before 10 (design eyeball
feeds 10's re-check); everything before 10. **Soft:** Phase 8's doc-link-check extension is assigned
to Phase 8 (not Phase 5) to avoid a two-phase edit of `repo-hygiene.test.ts`.

---

## 5. E2E appendix (real models, env-gated, weak-box)

E2e is a **confidence** leg in Phase 10, never the primary gate. It reuses the existing env-gated
harness (`tests/e2e-model/skills-smoke.test.ts`, `tests/manual/bringup-smoke.test.ts`).

**Preconditions (all must hold, else SKIP-with-reason, not fail):**
- The prepared drive is mounted (resolve `D:\` or `F:\` via `config/drive.json`).
- The **real** `llama-server.exe` is present — **size check > 1 MB** (the D: copy is a 9 KB stub;
  Phase 10 must verify the binary is real before attempting, and record "e2e skipped — stub binary" if
  not).
- RAM is free: close the dev app and stray Electron/node first (the 2.5 GB model + server needs
  headroom on a 17 GB / ~3 GB-free box).

**Command (smallest model, Windows):**
```
cd apps/desktop
cmd /c "set ELECTRON_RUN_AS_NODE=&& \
  set SKILLS_SMOKE_MODEL=F:/models/chat/qwen3-4b-instruct-2507-q4.gguf&& \
  set HILBERTRAUM_LLAMA_BIN=F:/runtime/llama.cpp/win/llama-server.exe&& \
  set SKILLS_SMOKE_ROOT=F:/&& \
  npx vitest run tests/e2e-model/skills-smoke.test.ts"
```
(Substitute `D:` for `F:` if that is where the drive with the real binary is mounted.)

**What e2e adds confidence on (not a substitute for the unit/integration RED→GREEN gates):**
- **AUD-01 / AUD-02 / AUD-03** — with a real sidecar running, exercise: create a real documents answer
  → review it → confirm the regenerate guard holds (AUD-01); start a real translation/vision task,
  click Lock now, confirm nothing respawns after lock (AUD-02); unlock a cold-cache model then quickly
  lock, confirm no `llama-server` survives (AUD-03). These are manual, driven through the app over CDP
  where possible; record observations in the ledger.
- Run **only the smallest model**; one model at a time; tear down between runs.

If any precondition fails, Phase 10 records `e2e: skipped (<reason>)` — the wave still passes on the
unit/integration gate. Do not block the PR on an env-gated e2e leg (matches the repo's manual-smoke
posture; CI rides mocks).

---

## 6. Testing-standards checklist (applied every phase)

- **RED→GREEN**: the characterization test fails before the fix (evidence pasted into the ledger),
  passes after.
- **No over-mocking**: injected-boundary fakes with teeth; real SQLite / real crypto where the repo
  already does. Preload mocks stay `Partial<PreloadApi>` (compile-checked).
- **No fixed sleeps**: gate on observable state (the repo's no-fixed-sleeps rule); ceilings only.
- **Index changes**: assert with EQP index-name (SEARCH not SCAN), the TS-5 idiom.
- **i18n**: EN+DE parity for any new user-visible string; `.one/.other` pairs; no ASCII quote closers
  in DE.
- **Teeth on nets**: plant-and-revert to prove a widened guard actually catches offenders.
- **Docs + BUILD_STATE**: updated in the same phase commit (the per-phase ritual).
- **Weak-box**: affected files per phase; full suite once (Phase 10, `--maxWorkers` capped); no
  coverage.
