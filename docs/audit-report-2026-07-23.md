# Full audit — 2026-07-23

**Scope:** whole-repo multi-perspective audit of HilbertRaum at `master` `bbf26add` (v0.1.55),
covering product correctness, backend/frontend architecture, security & data handling, performance,
reliability, tests, developer experience, documentation accuracy, and an in-app design/visual pass.

**Method.** Eight audit personas (product · backend · security · performance · renderer · tests · docs ·
DX) each swept their area in parallel, prioritising code touched since 2026-07-17 (the EP-1 evidence-pack
wave, the OCR-R wave, STR-1 grammar-constrained extract, DEP-1/DEP-2 dependency batches, and the
Gemma 4 QAT manifest wave), against a **complete dedupe index** of every prior finding, accepted
limitation, and open tracked item (audit ledgers `architecture.md` §46–§50 + the OCR-R ledger,
`known-limitations.md`, `BUILD_STATE.md` §5/§6/§8, and open issues #2/#21/#48/#53/#80/#82). Every
candidate finding was then handed to an **independent adversarial verifier** that had to either
reproduce the misbehaviour or trace the exact failing code path before it could be marked *confirmed*,
and — for confirmed code bugs — determine the blast radius and which shipped tags carry it. The
design pass launched the real app (dev build, `ELECTRON_RUN_AS_NODE` cleared), drove it over the
Chrome DevTools Protocol, captured all eight screens in **both themes** via the real in-app theme
control, and probed computed styles against `docs/design-guidelines.md`.

**Candidate → verdict funnel:** 28 candidates → **26 confirmed**, 1 refuted, 1 duplicate-of-known.
Everything already recorded in the ledgers/limitations/issues was filtered out before this report;
what remains is genuinely new (or, where noted, a live regression of a recorded item).

> This report does not modify code. It is written to be executed as a set of independent follow-up
> sessions (see §7). Per the run constraints it is **not staged or committed** — other sessions share
> this working tree.

---

## 1. Executive summary

**Overall health: strong.** The repo continues to hold its hard product guarantees. The security
persona re-verified them directly: **no new `fetch`/net/WebSocket call sites** anywhere in main or
preload since v0.1.51; the offline guard, vault crypto (argon2id/scrypt), CSP/permission handlers,
and the ids-only audit-log discipline are all intact; the new EP-1 HTML/PDF export surface escapes
every content-bearing string exactly once, parameterises all SQL, and exposes no filesystem
capability to the renderer. There are **zero Critical and zero High** confirmed findings. The suite
(~4680 tests / 334 files) remains trustworthy — real crypto, real SQLite, injected-boundary fakes
with teeth — and the visual pass found the two-token teal accent system and dual theme correctly
implemented in both light and dark.

The confirmed findings cluster, as expected, on the **two newest and least-audited surfaces**:

1. **The EP-1 evidence-review / pack feature** (shipped in v0.1.53, three tags old) accounts for the
   single most consequential finding and most of the Low tail. The headline: a documents-channel
   "Answer without it" one-click undo **silently and permanently CASCADE-deletes an entire evidence
   review** — human decisions, notes, and export history — with no warning, no count, and no undo,
   and even the designed "nothing lost" failure paths cannot restore it (**AUD-01**, Medium, and a
   defensible High given the app's own posture that this data warrants a warn-and-count confirm at
   the conversation level).

2. **The workspace "Lock now" contract.** Two independent races let a content-bearing sidecar
   (a ~10 GB translation model, a ~4.6 GB vision model) or a fresh `llama-server` **start or respawn
   after the workspace reports locked** (**AUD-02**, **AUD-03**, both Medium), violating the
   documented invariant that Lock now leaves nothing user-derived running. Confidentiality-hardening
   gaps, not data loss, and both present in every shipped tag v0.1.46–v0.1.55.

3. **The DIY provisioning scripts.** Under `$ErrorActionPreference='Stop'`, `Write-Error` in the
   PowerShell scripts turns deliberately-tolerant "warn and continue" paths into dead code, so a
   single transient download failure aborts `-WithAssets` provisioning instead of degrading
   gracefully — diverging from the `.sh` siblings the repo treats as canonical (**AUD-05**, Medium).

**Highest-priority risks (do first):**

- **AUD-01** — evidence-review silent data loss. One click from the review chip; permanent.
- **AUD-02 / AUD-03** — Lock-now sidecar/model start-after-lock (a shared "lock-in-progress latch"
  fixes both).
- **AUD-04** — Translate screen adopts and clobbers a held result / hijacks a Documents-row
  translation on plain navigation.

**Biggest opportunities:** a small `beginLock()`/`isLocking()` latch retires a whole class of
lock-window races at once (AUD-02, AUD-03, and the accepted CODE-2 residual); widening the hygiene
NUL/BOM nets to shell + launcher files (AUD-06) closes a silent-byte trap on the exact artifacts
paying-drive buyers launch; and batching the O(N) evidence-review-chip IPC (AUD-12) removes a
per-conversation-open serial round-trip fan-out.

**Severity counts (confirmed):** Critical 0 · High 0 · **Medium 7** · **Low 19** (+ 4 design
observations, one of which is a live sighting of a known residual).

---

## 2. Findings

Each finding carries a stable `AUD-nn` id. Locations are `file:line` at `bbf26add`. "Blast radius"
appears only for confirmed runtime-behaviour claims. Every finding was checked against the dedupe
index; the "Not previously known" line records why it is new.

### Medium

---

#### AUD-01 — Documents "Answer without it" silently CASCADE-deletes the answer's evidence review (unrecoverable)

- **Category:** likely-bug / data-loss · **Severity:** Medium (High arguable) · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/chat.ts:851`,
  `apps/desktop/src/main/services/db.ts:509`, `apps/desktop/src/main/ipc/chat-stream.ts:126`,
  `apps/desktop/src/renderer/chat/Transcript.tsx:361`,
  `apps/desktop/src/renderer/screens/ChatScreen.tsx:1656`

**Description.** The S13c/U3 "Answer without it" undo renders on *every* skill-stamped last assistant
turn (`Transcript.tsx:361 canUndo = isLast && onAnswerWithoutSkill != null` — no review check). In a
documents conversation it calls `stream(…, regenerate=true, skill=null)` → `askDocuments(regenerate)`
→ `withRegenerateGuard` → `deleteLastAssistantMessage` (`chat.ts:851 DELETE FROM messages WHERE id = ?`).
`evidence_reviews.message_id` carries `ON DELETE CASCADE` (`db.ts:509`) with `PRAGMA foreign_keys=ON`,
so the delete destroys the message's entire review chain — the `evidence_reviews` row (title, Ready
status, reviewer label, notes, freshness ack), all `evidence_review_items` (per-block decisions +
notes), all `evidence_review_links`, and all `evidence_exports` history rows — with no warning, no
count, no undo. Any documents-mode assistant turn is review-eligible (`shared/evidence-review.ts:18`),
and the review chip renders in the same action row as the undo button.

**Evidence.** Verified independently: `evidence_reviews … FOREIGN KEY (message_id) REFERENCES
messages(id) ON DELETE CASCADE` (db.ts:509), children cascade (items→links at :528/:539, reviews→exports
at :554). `restoreMessage` (chat.ts:876) re-inserts only the `messages` row; `DeletedMessage`
(chat.ts:774) snapshots no review data — so the **F2 non-abort-failure restore and the CB-2
Stop-before-first-token restore both bring the answer back but not the review**, permanently losing
human work-product even on the paths designed to lose nothing. The verifier reproduced the cascade
mechanically with the verbatim DDL under `node:sqlite`: review-chain counts 1,1,1,1 → 0,0,0,0 after
the delete, still 0,0,0,0 after `restoreMessage`. Contrast the app's own posture: *conversation*
delete deliberately warns and counts (`countEvidenceReviewsForConversation`, wired to the D-2
confirm) — message-level regenerate got no such guard, main-side or renderer-side.

**Consequences.** A user who reviews a skill-shaped documents answer (records decisions/notes,
possibly marks it Ready and exports a pack) and then clicks the adjacent "Answer without it" loses
the whole review silently and permanently — including the `evidence_exports` row whose recorded
SHA-256 an already-exported pack file's integrity section points at (the pack claims its hash is on
record; the record vanishes).

**Blast radius.** *Flows:* documents conversation → skill-stamped last answer → create review →
click the one-click undo. Not reachable from plain chat (chat answers are never review-eligible) or
documents-mode Try-again (disabled). *Platforms:* all (pure SQLite FK-cascade in main). *Data:*
permanent silent loss of human review work-product; the exported pack file survives but its integrity
record does not. *Introduced:* interaction went live with EP-1 P0 schema `eca08608` (2026-07-18) on
top of the pre-existing U3 undo. *Shipped in:* **v0.1.53, v0.1.54, v0.1.55**.

**Recommended fix.** Main-side gate is the airtight option (regenerate=true is caller-supplied over
IPC): in `withRegenerateGuard`/`deleteLastAssistantMessage`, refuse the delete when the target
message has an evidence review, with a localized "reopen or delete the review first" message
mirroring the D-2 conversation-delete posture; and in the renderer, hide or confirm the "Answer
without it" affordance when `reviewSummaries` has an entry for that message. (Alternative: extend the
F2 snapshot to capture and restore the whole review chain — larger, and still leaves the
non-restoring caller unguarded.)

**Testing needed.** Integration: documents conversation → skill-stamped answer → create review with
a decision/note → "Answer without it" → assert the delete is refused (or the review survives) and
`getEvidenceReviewForMessage` still resolves. Second: force a non-abort regenerate failure → answer
restored **and** review intact.

**Docs.** Note the guarded interaction in the EP-1 record (`architecture.md` §2/§8) and the
user-guide review section.

**Not previously known.** The EP-1 record documents the message-FK cascade and the D-2 warn only for
*conversation* deletion; `known-limitations.md`'s "Try again optimistically drops the last answer …
never data loss" covers only the renderer view-slice race. No ledger, limitation, or test records the
regenerate→review interaction.

---

#### AUD-02 — "Lock now" teardown window admits fresh doc-task / translate / vision / import starts that respawn content-bearing sidecars past the lock

- **Category:** reliability / confidentiality · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/ipc/registerWorkspaceIpc.ts:246-337`,
  `registerDocTasksIpc.ts:35-43`, `services/doctasks/manager.ts:513-531`,
  `registerTranslateIpc.ts:63`, `registerImagesIpc.ts:181`, `services/vision/index.ts:120-241`,
  `registerDocsIpc.ts:321-343`

**Description.** The interactive lock handler runs a multi-second *awaited* teardown —
`Promise.allSettled` of sidecar suspends, `awaitInFlightStreamsSettled` (≤5 s),
`awaitActiveDocTaskSettled` (≤5 s), `purgeResidentVectors` — **before** `ctx.workspace.lock()` flips
`isUnlocked()` false at line 337. Every content-surface admission guard is a plain
`ctx.workspace.isUnlocked()` check, all of which still pass during that window because the DB is still
open; and the renderer stays fully mounted and clickable until `lockWorkspace()` *resolves* (TA-2:
`App.lockNow` swaps to the gate only after the invoke returns). So a `startDocTask('translation')`,
`translateStart`, `imageAnalyze`, or `importDocuments` landing 1–10 s after the user clicks Lock now
is admitted, `pump()`s immediately, and — because `suspend()`/`stop()` are deliberately non-latching
for the remainder of the handler — **lazily respawns the just-suspended sidecar**: a ~10 GB
TranslateGemma with document text in its KV cache, a ~4.6 GB vision runtime with image-derived
prefill, or the E5 embedder with chunk text.

**Evidence.** `isUnlocked() = _db !== null` (workspace-vault.ts:1103), nulled only inside `lock()`.
An async `ipcMain.handle` yields the main thread at each `await`, so an invoke arriving during the
teardown is dispatched. `VisionService.tearingDown` clears in `stop()`'s own `finally` (index.ts:239),
so the REL-2 latch does not cover the rest of the lock handler; the translation runtime's own comment
states `suspend()` is non-latching. The TA-1 H2 fix (`cancelAllDocTasks`) closed exactly this hole for
tasks *already queued* when lock began, but a task *admitted during the window* recreates it verbatim;
`jobs.ts:119` even names the intended defense as "the requireUnlocked guard bars a fresh start during
lock" — which only bars *after* line 337. No `isLocking`/`beginLock` latch exists anywhere.

**Consequences.** A content-bearing sidecar child keeps running (holding user-derived content in RAM)
after the workspace reports locked — the exact invariant the lock path exists to guarantee — until
idle-teardown or the next lock/unlock/quit. A plaintext `.parse` transient may be written during the
window (shredded by the handler's `finally` on a normal unwind; left for the next-launch sweep only
on a hard mid-window kill).

**Blast radius.** *Flows:* interactive Lock now racing a content action on the still-mounted shell.
*Platforms:* all (main-process event-loop logic). *Data:* no at-rest leak or loss; RAM-residency
confidentiality gap. *Introduced:* architectural — absence of a locking latch across a growing awaited
window; widest current window since TA-1 `9a47ecf5` (2026-07-06). *Shipped in:* **all tags
v0.1.46–v0.1.55.** Probability is low-moderate (a seconds-wide window requiring a racing user action)
but it opens on every interactive lock.

**Recommended fix.** Arm a "lock in progress" latch as the handler's **first** act (cleared only on
lock failure) — `WorkspaceController.beginLock()` making a new `isLocking()` (consulted by every
`requireUnlocked`, `DocTaskManager.startDocTask`, `TranslateJobService.start`, `VisionService.analyze`,
and the import loop) report locked for the whole teardown, so fresh admissions refuse with the
existing friendly locked copy. Mirrors the existing runtime-level `tearingDown`/`stopped` latch
pattern. **Fixes AUD-03 in the same stroke.**

**Testing needed.** Integration: drive `IPC.lockWorkspace` with a deferred/gated sidecar suspend,
issue `startDocTask('translation')` / `translateStart` / `imageAnalyze` while the handler is parked in
its awaited teardown, assert each is refused and no `translate()`/`createRuntime` call fires.

**Not previously known.** TA-1 H2 closed only the already-queued dequeue path; vision REL-2 covers
only `stop()`'s own duration; CODE-2 is a `RuntimeManager` start-cancel — none covers fresh IPC
admissions during the teardown. `architecture.md:2876` even asserts "sidecars only ever start
post-unlock", which this falsifies.

---

#### AUD-03 — Background model auto-start races "Lock now": the multi-GB weight hash has no lock-side latch, so `llama-server` starts after the workspace locked

- **Category:** reliability / lock-contract · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/ipc/registerModelIpc.ts:61-107`,
  `services/runtime/index.ts:151-178`, `registerWorkspaceIpc.ts:107`, `services/models.ts:350-362`

**Description.** `maybeAutoStartActiveModel` fires on every unlock; `startModelRuntime` then spends its
long pre-start window in `computeInstallState`, hashing a multi-GB GGUF (minutes on a cold checksum
cache — the first-ever unlock of a prepared or freshly-copied drive). CODE-3 closed exactly this window
for **quit** (the latch is armed first in `performShutdown`, and `startModelRuntime` re-checks
`isShutdown()` after the hash). The **lock** path has no equivalent: the lock handler's `runtime.stop()`
finds `startingRuntime === null` (set only once `runtime.start()` is invoked), the CODE-3 latch is
quit-only, and `startModelRuntime` never re-checks `ctx.workspace.isUnlocked()`. The lock-aware hash
store deliberately swallows the closed-DB write (`models.ts:360` — "in-memory fallback keeps the
session served"), so nothing fails the pipeline: after the lock completes, the hash resolves, the RAM
gate passes (OS-only), `isShutdown()` is false, and `ctx.runtime.start()` spawns a full `llama-server`
while the app sits at the unlock gate.

**Evidence.** `registerModelIpc.ts:61` `await computeInstallState` (its own CODE-3 comment names the
"long pre-start window"); `:93` re-checks only `isShutdown?.()`; `:98` `await ctx.runtime.start(...)`
unconditionally after. The lock handler (`registerWorkspaceIpc.ts:246-353`) contains no
`runtime.shutdown()`/latch. Factory GPU-settings reads degrade to safe defaults when locked
(`main/index.ts:213`), so the start cannot fail on those either.

**Consequences.** A full `llama-server` (multi-GB RAM + a `127.0.0.1` port) starts and keeps running
while the workspace is locked, contradicting the documented lock contract (`security-model.md:726`);
`runtime.status()` reports a running model at the unlock gate. No user content reaches it (chat is
unlock-gated, KV cache empty at start) — resource/consistency, not data exposure.

**Blast radius.** *Flows:* unlock-then-quick-lock while the active model's weight hash is cold (first
unlock of a prepared/copied drive — a copy changes mtime and invalidates the size+mtime cache — or
right after a download); also any `startRuntime`/`useModel` IPC racing a lock. *Platforms:* all. *Data:*
none (post-lock cache write swallowed by design). *Introduced:* `22c8df85` (2026-06-10, added
unlock-time auto-start); the CODE-3 fix closed the identical window for quit only. *Shipped in:* **all
tags v0.1.46–v0.1.55.**

**Recommended fix.** After `computeInstallState` resolves, re-check the workspace is still unlocked
(and the new AUD-02 lock-in-progress latch) before touching `ctx.runtime` — the CODE-3 pattern applied
to the lock path. An unlock-epoch capture at entry closes the residual micro-window fully.

**Testing needed.** Core-model-ipc unit test: gate `computeInstallState` (injectable hash store),
run `maybeAutoStartActiveModel`, complete a lock while the hash is parked, release it, assert
`runtime.start` was never invoked (mirror of the CODE-3 quit-latch test).

**Not previously known.** CODE-3 is explicitly quit-only; the CODE-2 residual is a start already
queued inside the manager (different window). No limitation or item covers it.

---

#### AUD-04 — `adoptActiveFileTranslation` clobbers a held terminal result and hijacks a Documents-screen translation (guard checks `busy`, not non-idle, contradicting its own contract)

- **Category:** likely-bug · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/lib/fileTranslateSession.ts:492`, `:500-513`,
  `apps/desktop/src/renderer/screens/TranslateScreen.tsx:165-168`

**Description.** `adoptActiveFileTranslation` (the post-reload recovery for document translations)
documents that it "no-ops … when this store already holds a live/**terminal** session" (fileTranslateSession.ts:487),
but the implemented guard is only `if (snapshot.busy) return` (line 492), and `busy` is `false` for
terminal states (`done`/`failed`/`cancelled`). The function runs on **every** TranslateScreen mount
(not only after a reload) and cannot distinguish its own task from a foreign one: DocumentsScreen
starts `startTask('translation', …)` through the global doctasks store, which `getActiveDocTask()`
reports as a running translation — and unlike `guardStart` (:190), the adopt path never consults that
store.

**Evidence.** Lines 504-511 execute `set({ ...EMPTY, state:'translating', busy:true, fileName:null, … })`,
discarding the held output/gaps/truncated/`resultDocumentId` of a completed translation. Concrete
repro (verifier, full static trace): translate a document on the Translate screen to completion → go
to Documents and start "Translate" on any row → return to Translate: the mount adopt replaces the done
result panel with "Translating…" for the foreign task, the Stop button now cancels the Documents-row
task, and on completion the panel loads that task's output as if it were a file translation. From an
idle store, plain navigation alone hijacks a Documents-row translation into the panel. Tests
(`fileTranslateSession.test.ts:459-546`) cover running-adopt, no-task, non-translation, and
text-precedence — **neither the terminal-session nor the foreign-task case.**

**Consequences.** The completed translation's preview, truncated flag, gaps accounting, and
Export/Show-in-Documents affordances are lost from the panel (the materialized document persists under
Documents, so no data destroyed); pressing Stop misattributes a cancel to an in-flight Documents-row
translation.

**Blast radius.** *Flows:* Translate result panel + Documents-row translation tasks. *Platforms:* all
(pure renderer store). *Data:* no persistent loss; in-panel session state only + one misattributed
(but user-initiated) cancel. *Introduced:* `3971beef` (2026-07-06, FA-3, the busy-only guard).
*Shipped in:* **all tags v0.1.46–v0.1.55.** Survived normal use because everyday navigate-away-and-back
with a done result and no new task does not clobber (main returns null → the `state==='running'` gate
bails).

**Recommended fix.** Change the guard to `if (snapshot.state !== 'idle') return` (implements the
documented live/terminal no-op) **and** skip adoption when the renderer-global doctasks store already
tracks the running task (it survives navigation; empty only after a genuine reload — exactly FA-3's
target): `const g = getActiveDocTask(); if (g && g.jobId === task.jobId && !isDocTaskTerminal(g.status)) return`.
`guardStart` already demonstrates the idiom.

**Testing needed.** Unit: seed store to `done` with output + stub `getActiveDocTask` to a running
translation → assert snapshot untouched. Second: idle store + a foreign task tracked by `lib/doctasks`
→ no adopt.

**Not previously known.** The FA-wave ledger records F-3 fixed with no residual;
`known-limitations.md:1726` tolerates only the null-`fileName` cosmetic edge.

---

#### AUD-05 — `Write-Error` under `$ErrorActionPreference='Stop'` makes the PowerShell provisioning scripts' continue/best-effort paths dead code

- **Category:** confirmed-bug · **Severity:** Medium · **Confidence:** High
- **Location:** `scripts/fetch-runtime.ps1:184` (`$failed++; continue`), `:323`, `:255`, `:157`, `:165`;
  `scripts/prepare-drive.ps1:305-310`; `scripts/fetch-models.ps1:59-60`

**Description.** All provisioning `.ps1` scripts set `$ErrorActionPreference='Stop'`, which promotes
`Write-Error` to a script-terminating exception. Two intended-tolerant paths are therefore dead: (1)
`fetch-runtime.ps1`'s OCR loop `Write-Error 'download failed after retries'; $failed++; continue` — the
`$failed++; continue` never runs, so the first failed language file aborts the whole batch (`eng` after
`deu` never attempted), diverging from `fetch-runtime.sh` which continues per-file and exits 1 at the
end; (2) `prepare-drive.ps1`'s documented best-effort whisper step ("a miss is a warning, not a
failure") is dead — when the in-process-invoked `fetch-runtime.ps1` fails via `Write-Error`, the
exception propagates through the `&` call and kills `prepare-drive.ps1` before the tolerant
`if ($LASTEXITCODE -ne 0)` note, so a transient whisper failure aborts the entire `-WithAssets`
provisioning (OCR files never fetched — the exact issue-#59 class F-05 was meant to close). Every
`Write-Error … ; exit 2` pair also exits **1**, collapsing the documented config-error code.

**Evidence.** All three behaviours reproduced on the real host (PS 5.1, `powershell.exe -File`) with
scratch scripts replicating the exact source patterns: the OCR loop stopped at the first `Write-Error`
(later iterations + trailing summary never ran, exit 1); `Write-Error … ; exit 2` exited 1; the parent
`& $child` invocation was killed by the child's `Write-Error` before its tolerant `$LASTEXITCODE`
branch. `Invoke-CurlResilient` *returns* `$false` (does not throw), so the `Write-Error` in the guard
is the terminating trigger. The `.sh` siblings neutralise `errexit` with `|| { …; continue; }` and
`if ! bash …; then`, attempting all files then exiting 1/2 as designed.

**Consequences.** On Windows (the first-class DIY platform) a single transient download failure during
`prepare-drive.ps1 -WithAssets` aborts provisioning instead of degrading gracefully: OCR language files
silently unavailable, final guidance never printed; the whisper "warning, not failure" contract holds
only on the `.sh` side; exit-code 2 (config error) is indistinguishable from 1 (download failure) on
the ps1 side.

**Blast radius.** *Flows:* Windows DIY drive provisioning (`prepare-drive.ps1 -WithAssets`; standalone
`fetch-runtime.ps1 --family ocr`). Also mac/linux when the ps1 is run via `pwsh`. *Platforms:* Windows
first-class; the `.sh` scripts are unaffected. *Data:* none (build-time tooling); worst case a
partially-provisioned drive, recoverable by an idempotent re-run. *Introduced:* whisper block
`e1c4293f` (2026-06-13, v0.1.19); OCR-loop/curl-failed `Write-Error` `33d572b7` (2026-06-15, v0.1.22).
*Shipped in:* **v0.1.46–v0.1.55.** Worth checking whether `runtime-sources.yaml`'s whisper win URL is a
live release asset or a placeholder that 404s deterministically (which would make the whisper abort
happen every run, not just on transient failures).

**Recommended fix.** Replace `Write-Error` with `Write-Host -ForegroundColor Red` + explicit `exit`
(the pattern the same scripts already use at `:332`/`:434`) in the continue/tolerant paths, or wrap the
OCR loop body and `prepare-drive`'s `&` child invocations in `try/catch`. Restore the exit-2 codes.

**Testing needed.** Run `fetch-runtime.ps1 -Family ocr` with the first URL unreachable → observe the
batch abort at the first file; run `prepare-drive.ps1 -WithAssets` with the whisper URL unreachable →
observe full abort before the OCR step. A drift/behaviour guard is feasible (`script-drift.test.ts`
already string-parses these).

**Not previously known.** F-04 fixed the `.sh` side; F-05 added the ocr fetch but not the
`Write-Error`/EAP semantics; F-18 fixed a different `setup-dev.ps1` site. No item covers these
`fetch-runtime.ps1`/`prepare-drive.ps1` `Write-Error` sites.

---

#### AUD-06 — Repo-hygiene NUL/BOM nets exclude `launchers/` and all `.sh`/`.ps1`/`.cmd`/`.command` files — the byte-0-sensitive shipped scripts are unguarded

- **Category:** test-gap · **Severity:** Medium (High arguable) · **Confidence:** High
- **Location:** `apps/desktop/tests/integration/repo-hygiene.test.ts:48`, `:145`, `:158-173`

**Description.** The CODE-24/TQ-1 NUL and BOM nets walk src, tests, scripts, docs, app-skills, .github,
model-manifests, licenses, and root `*.md` — but their shared extension filter
`\.(ts|tsx|js|jsx|mjs|cjs|mts|json|css|md|html|yml|yaml|txt)$` excludes `.sh`, `.ps1`, `.cmd`, and
`.command`, so the `scripts/` walk covers only the `.mjs` files there, not the 6 `.sh` + 8 `.ps1`
provisioning scripts. Worse, the `launchers/` root (`Start HilbertRaum.cmd`, `Start HilbertRaum.command`,
`start-hilbertraum.sh`, `READ ME FIRST.txt` — copied verbatim onto every commercial-drive root by
`build-commercial-drive` step 5) is not walked by either net at all. These are precisely the files
where a BOM is most fatal: a UTF-8 BOM before `#!` breaks shebang recognition, so
`start-hilbertraum.sh` / `Start HilbertRaum.command` would silently stop launching on the buyer's
machine.

**Evidence.** Verified: both nets use the identical filter (repo-hygiene.test.ts:48/145) excluding the
shell extensions; `launchers/` is absent from the BOM-net root list (:158-173) and nothing else walks
it (`grep launchers tests/` → only copy-list drift checks). All four launcher files and all
`scripts/*.{sh,ps1}` currently start clean (byte-verified `23 21 2f`, no `EF BB BF`) — a **live
enforcement hole, not an active break.** TQ-1's own comment admits "PowerShell 5.1 writes BOM'd UTF-8
by default on this dev machine, so the class is one careless `Out-File` away."

**Consequences.** A single BOM'd save of a launcher or provisioning shell script — one `Out-File` away
on the primary dev machine — ships undetected through the required green gate; on the drive the
mac/linux launchers silently fail to execute for a non-technical buyer, the exact silent-byte-trap
class the nets were built to make unregressable.

**Blast radius.** *Flows:* none currently broken (test-gap). If regressed: commercial-drive buyers on
mac/linux cannot launch the app; `.sh` provisioning scripts stop being directly executable.
*Platforms:* mac/linux for shebang breakage; the authoring risk lives on the Windows dev machine.
*Data:* none; silent launch failure on sold drives. *Introduced:* gap present since the TQ-1 nets
(2026-07-12); shell extensions and `launchers/` never included in any widening. *Shipped in:* all tags
carry the gap; no release carries an actual BOM'd file.

**Recommended fix.** Add `sh|ps1|cmd|command` to both nets' shared extension filter and add
`launchers/` to both root lists (no `node_modules` there; recursive walk safe). Keep both `.ps1` and
`.cmd` under the NUL net regardless of the BOM question. (The verifier leaned **High** given the
sensitivity of the shipped artifacts; kept at Medium here because nothing is currently broken.)

**Testing needed.** Plant a BOM'd copy of a launcher and a shell script under temp, assert both nets
fail; revert.

**Not previously known.** No BOM/NUL/hygiene item touches launchers or `.sh`/`.ps1`; the TQ-1/LIC-1
widenings never added these extensions or root.

---

#### AUD-07 — `known-limitations.md` and `packaging.md` still present packaged-app OCR as "wired, verify at release" although DEP-1 verified it broken and app-killing

- **Category:** doc-mismatch · **Severity:** Medium · **Confidence:** High
- **Location:** `docs/known-limitations.md:1908`, `docs/packaging.md:180`, `docs/architecture.md:2426`
  (R-O2 row), and the `apps/desktop/electron-builder.yml:139-146` comment

**Description.** The DEP-1 record (`architecture.md:9454`, dated 2026-07-19) records a **verified**
result: packaged OCR is broken and version-independent — the tesseract.js worker under
`app.asar.unpacked` cannot resolve hoisted deps (`regenerator-runtime`, `is-url`, …) that stay packed
inside `app.asar`, and "the uncaught exception kills the whole app while `ocrAvailable` still reports
true." The fix bundle is registered (DEP-1 §5 #2 / BUILD_STATE §5 item 16(b)) but not landed. Yet three
other surfaces still carry the pre-discovery optimistic framing: `known-limitations.md:1908` ("Wired in
electron-builder.yml; verifying a real OCR run … is a release-acceptance item"), `packaging.md:180`
("After packaging, also smoke-test 'Make searchable (OCR)' … from the produced .exe" — no crash
warning), and the `architecture.md:2426` R-O2 row.

**Evidence.** Verified: the two texts contradict directly (known-limitations.md:1908 "release-acceptance
item" vs architecture.md:9454 "broken … kills the whole app"). `electron-builder.yml:144-146` still
`asarUnpack`s only `tesseract.js`/`tesseract.js-core` — the exact insufficiency §4(c) names — so the
broken state is current. `known-limitations.md` was last edited 2026-07-20 (STR-1), *after* the
2026-07-19 discovery, without reconciling this bullet.

**Consequences.** `known-limitations.md` is the declared honest register of accepted gaps and
`packaging.md` is the drive-builder's instruction set; both currently understate a verified app-killing
failure as merely "unverified." A release tester following `packaging.md`'s smoke instruction hits a
whole-app crash the surrounding docs suggest should work; a contributor triaging it is pointed away
from the known root cause.

**Recommended fix.** Update the `known-limitations.md` bullet, the `packaging.md` asarUnpack paragraph,
the `architecture.md:2426` R-O2 row, the `electron-builder.yml:139-143` comment, and BUILD_STATE §5
item 15(b) to state the DEP-1 §4(c) verified result: packaged OCR currently crashes the app
(hoisted-dep resolution under `app.asar.unpacked`); fix bundle is DEP-1 §5 #2; **dev-mode OCR is
unaffected** (proven end-to-end on E39). Use the OCR-R "docs truth" superseding-note precedent rather
than rewriting dated records.

**Testing needed.** None (doc fix). Optionally pin the packaged-OCR entry to reference the follow-up
register.

**Not previously known.** DEP-1 §5 #2 and BUILD_STATE §5 item 16(b) register only the *code* fix
bundle, not the reconciliation of these three doc surfaces.

---

### Low

The Low tail is grouped by area. Each entry gives location, the confirmed mechanism, consequence, and
fix. All were adversarially verified (except where a fix is a one-liner doc edit, verified by direct
inspection). Blast radius is summarised inline; all EP-1 items ship in **v0.1.53–v0.1.55** unless noted.

**Evidence-pack / review correctness**

- **AUD-08 — Source-context modal shows the chunk-overlap text twice.**
  `evidence-pack/source-context.ts:143-150`, `renderer/review/SourceContextModal.tsx:91`. The chunker
  re-includes ~80 tokens of the previous window's atoms; when the "Open source in context" modal joins
  consecutive same-segment chunks it does not strip that overlap, so a byte-exact ~450-char run appears
  twice (reproduced at 454 chars on the default 500/80 config). Transient IPC result only — nothing
  persisted, no data loss; purely a misleading context display. *Fix:* de-overlap on join (drop the
  shared prefix run), mirroring the summarization-input de-overlap. Add a two-adjacent-chunk test.
  *(Distinct from the known summarization/extract/diff double-count limitations, which cover different
  paths.)*

- **AUD-09 — Review summary export toggle keeps `aria-expanded="true"` (and auto-reopens) after the
  outdated-export gate unmounts the panel.** `renderer/review/ReviewSummaryView.tsx:232-234`, `:277-284`.
  With `freshness` still null at mount, `exportBlocked` is false, so the toggle can open; when the
  async freshness verdict lands outdated-unacknowledged and gates the panel, the toggle's
  `aria-expanded` state is never reconciled. Screen-reader users hear "expanded" on a disabled control;
  a re-enable re-opens spontaneously. Presentation state only; no export can occur while gated
  (main-side §28.6 is independent). *Fix:* reset the disclosure state when `exportBlocked` flips true.

- **AUD-10 — Narrow-mode evidence drawer re-opens spontaneously (with focus trap) when the window is
  narrowed again.** `renderer/screens/ReviewScreen.tsx:82`, `:406-414`. `drawerOpen` is never reset on
  leaving narrow mode (>980px), so a previously-opened drawer silently re-opens (and traps focus) the
  next time the window is narrowed — trivially triggered by Windows snap. No writes; focus/UX/a11y
  defect. *Fix:* reset `drawerOpen=false` in the media-query "leave narrow" branch.

- **AUD-11 — Evidence pane reveal button says "and N more sections" for SOURCE cards, contradicting the
  adjacent "{shown} of {total} sources shown".** `renderer/review/EvidencePane.tsx:204`,
  `shared/i18n/en.ts:390`, `de.ts:415`. When a review's evidence list exceeds the 24-card cap, the
  reveal control reuses the "sections" copy for source-kind cards. i18n mismatch, EN + DE. *Fix:*
  dedicated `review.evidence.more.one/.other` key pair.

**Performance (evidence-review path)**

- **AUD-12 — Evidence-review chip state loads with O(N) serial IPC round-trips per conversation open.**
  `renderer/screens/ChatScreen.tsx:593-601` (`for (const m of unknown) { await
  window.api.getEvidenceReviewForMessage(m.id) }`), `registerEvidenceReviewsIpc.ts:197`,
  `evidence-reviews.ts:552`. Every open/switch of a documents-mode conversation with history issues one
  IPC round-trip per candidate message, each doing a full item-row load plus a freshness recompute.
  Read-only (failures degrade to chip-hidden); latency scales with history length. *Fix:* a single
  batch `getEvidenceReviewSummariesForConversation(convId)` returning the chip-relevant summary rows.

- **AUD-13 — Bulk review actions fan out into one IPC write per item, each paying a redundant
  review-lock re-read, head-touch UPDATE, and full item re-read.** `renderer/lib/reviewSession.ts:612-641`,
  `:286-304`, `evidence-reviews.ts:778-800`. The three sanctioned bulk actions (mark headings N/A,
  clear all decisions, mark undecided follow-up) issue N individual writes with per-item overhead; a
  crash mid-flush leaves a partially-applied bulk action. *Fix:* a single batched IPC that applies the
  bulk change in one transaction.

- **AUD-14 — `evidence_reviews` has no index on `conversation_id` although the column exists solely to
  serve the delete-confirm COUNT.** `db.ts:489-511`, `evidence-reviews.ts:572`. The D-2
  `countEvidenceReviewsForConversation` COUNT scans (EQP SCAN, not SEARCH). Near-negligible today;
  additive index closes it. *Fix:* `CREATE INDEX idx_evidence_reviews_conversation ON
  evidence_reviews(conversation_id)` (matches the existing additive-index idiom).

- **AUD-15 — Evidence-pack export performs multi-MB synchronous fs (write + `fsyncSync` + full
  read-back + sync HTML print-source write) on the Electron main thread.**
  `evidence-pack/export.ts:149-177`, `print-pdf.ts:150`. The atomic-write contract (tmp → fsync → hash
  read-back → rename) is correct but synchronous; during the tail the whole main process stalls. Same
  class as the F-12 image-history sync-fs finding that was ported to async. *Fix:* async twins
  (`fs.promises` + `fsync` via a handle), preserving the atomic/hash-verify contract.

**Security / reliability (PDF export)**

- **AUD-16 — PDF export's plaintext print-source cleanup failure is swallowed silently — unlogged
  decrypted-content residue.** `evidence-pack/print-pdf.ts:178-186`. The `finally` runs
  `rmSync(sourceHtmlPath, {force:true})` inside a catch whose body is only a comment, and the file
  imports no logger; on Windows an AV/indexer handle without `FILE_SHARE_DELETE` makes the unlink throw
  (reproduced on the dev box), leaving an extra **plaintext** copy of already-rendered pack content on
  disk with no log line. *Fix:* `log.warn` (ids-only) in the catch + one retry (removal succeeds once
  the scanning handle closes). Update `security-model.md:381-385` to note the residue window.

- **AUD-17 — Concurrent same-destination PDF exports can succeed with swapped pack content; the code
  comment claims the collision "fails cleanly".** `evidence-pack/print-pdf.ts:41-46`, `:150`, `:166`,
  `registerEvidenceReviewsIpc.ts:389`. Reproduced on the installed Electron 39 (12/12 runs): after
  `win.loadFile(src)`, an overwrite of `src` in a later main-process turn is picked up and printed
  successfully. Two concurrent PDF exports to the identical destination can produce a pack whose bytes
  are review A's but whose `evidence_exports` provenance row is review B's. No workspace data lost;
  provenance corruption of one export. *Fix:* per-export unique print-source path (include the packId),
  and/or serialise exports on the shared source.

**Test quality**

- **AUD-18 — The BE-2 packaged-CSP build guard silently degrades to a green skip if the build-output
  layout ever drifts.** `tests/integration/csp-build-output.test.ts:24`, `:35`, `:53`.
  `built = PAGES.every(existsSync(...))` with a hardcoded `OUT_RENDERER`, and `describe.skipIf(!built)`
  gates *both* real security assertions — a future renderer `outDir`/page-layout change silently
  disables the only automated check of the packaged CSP. *Fix:* the repo's own CODE-46 pattern —
  `it('guard ran on CI', () => { if (process.env.CI) expect(built).toBe(true) })`.

- **AUD-19 — `canonicalCoverage` hand-enumerates `CoverageInfo`'s fields with no exhaustiveness
  tooth.** `evidence-pack/freshness.ts:80`. The freshness drift fingerprint builds a plain object
  literal with nine hand-listed fields, unconstrained to `keyof CoverageInfo`; a future coverage field
  is silently excluded from drift detection (an export could then proceed without the
  outdated/acknowledge gate for that field). Latent maintainability gap, no current defect. *Fix:* a
  `satisfies Record<keyof CoverageInfo, …>`-style exhaustiveness constraint or a keys-parity test.

- **AUD-20 — `script-drift.test.ts` validates the runtime-build matrix of `build-commercial-drive.ps1`
  only — the `.sh` twin's hard-coded matrix is unguarded.** `tests/integration/script-drift.test.ts:84-95`,
  `scripts/build-commercial-drive.sh:239-245`. A future mac/linux-built commercial drive could be gated
  against a stale runtime matrix (wrongly SELLABLE) with no test catching the `.sh` drift. *Fix:*
  extend the drift assertion to parse and compare the `.sh` matrix too.

**Documentation**

- **AUD-21 — `docs/data-contracts.md` carries four broken relative links (`docs/docs/…`).**
  `data-contracts.md:205`, `:250`, `:268`, `:303`. Left over from the 2026-07-12 verbatim move out of
  `BUILD_STATE.md`: `[…](docs/rag-design.md)` resolves to `docs/docs/rag-design.md` from within
  `docs/`. Verified: those paths do not exist. *Fix:* sibling-relative targets (`rag-design.md`,
  `benchmark.md`), and extend the DOC-1 hygiene link-check to `docs/*.md` to close the relocation class.

- **AUD-22 — `model-manifests/README.md` omits the `translation/` role directory (TranslateGemma).**
  `model-manifests/README.md:7`. The directory listing names chat/embeddings/reranker/transcriber/vision
  but not `translation/`, which exists and ships. No runtime impact (discovery is recursive); a
  contributor gap. *Fix:* one-line bullet.

- **AUD-23 — README "Chat models" table omits two downloadable catalog manifests (Qwen3.5 0.8B Q6_K,
  Qwen3.5 2B UD-Q4_K_XL) while listing every other rank-0 challenger.** `README.md:212`. Manifest census:
  20 `download:` blocks vs 18 README rows. DIY users sizing low-RAM machines from the README miss the
  smallest downloadable chat models. *Fix:* add the two rows with the honest §9 verdict notes (0.8B
  surviving candidate, 2B failed), per the DOC-3 precedent already applied in `model-policy.md`.

**Developer experience / maintainability**

- **AUD-24 — `fetch-models` mismatch "redo" path re-downloads without deleting the corrupt file
  first.** `scripts/fetch-models.ps1:157-167`, `scripts/fetch-models.sh:127-133`,
  `scripts/fetch-runtime.ps1:178`. With resume-at-end (`curl -C -`), a size/hash mismatch triggers a
  redo that resumes the *existing* corrupt file → an unsatisfiable range → HTTP 416, making the first
  repair attempt a guaranteed no-op/failure. Reproduced with curl 8.21. On modern curl (≥7.76,
  ubiquitous today) it self-heals in two runs with no data loss (verify-before-trust holds); Low. *Fix:*
  delete the destination before the redo re-download.

- **AUD-25 — Dead exported functions and ~70 export-only symbols in `src` (no reference outside their
  defining file).** e.g. `services/analysis/node-vectors.ts:218` (`nodeVectorSearch`),
  `services/skills/loader.ts:88`, `services/runtime-download.ts:782`. Maintainability only; note the
  verifier's correction that `nodeVectorSearch` is an already-documented, deliberately-retained
  fallback (rag-design), so it should stay. *Fix:* prune the genuinely-dead ones; add a
  knip/ts-prune-style check if desired (out of scope to wire into CI here).

- **AUD-26 — CI tests on Node 22.x / npm 10.9 — below the repo's own `engines.npm >=11` floor — while
  release builds/tests on Node 24; the pinned npm never runs in CI.** `.github/workflows/ci.yml:60`,
  `.github/workflows/release.yml:41`, `package.json:20-24`. The declared npm floor is dead policy
  (never exercised), and the Node major the win release leg runs full `npm test` under (24) is never
  exercised by CI (22). *Fix:* bump `ci.yml` to Node 24 (or a matrix incl. 24) so the release Node and
  the pinned npm are actually gated; optionally add `corepack enable` so `npm@11.6.2` is what runs.

---

### Verified-and-dismissed (recorded for completeness)

- **Refuted candidate — rank-0 catalog auto-pick RAM sampling.** A finder proposed that
  `committed-catalog.test.ts`'s 10-fixed-RAM-level sampling could miss a RAM mis-edit in the acknowledged
  residual window. The verifier disproved it (the `preferRanked` guard in `recommendModelIdByRam`
  excludes rank-0 models whenever any ranked model fits, and ranked 16 GB models exist), leaving only a
  single-integer residual (rec=15, ram=15, small Qwen3.5 rank-0 models only) — recorded here, not worth
  a dedicated fix.

- **Duplicate of a known residual — engine-download tar child orphaned on graceful quit.**
  `shutdown.ts` has no reference to the `EngineDownloadManager`, so a tar-extraction child (with a
  deadline timer that dies with the app) is orphaned if the app quits during the brief "extracting"
  step on Windows. This is the same architectural gap as **BUILD_STATE §5 item 9 "Downloads on quit"**
  (a `downloads.cancelAll()`-style teardown fixes it). Recorded as a **live sighting that slightly
  extends** the known item: the registered residual names the *model* download `.part` stream; this is
  the separate *engine* downloader's tar child. Worst case is a one-time confusing engine-install
  failure, no user-data impact.

---

## 3. Documentation audit

**Verified accurate (spot-checked against code/manifests/lockfile today):** the Gemma 4 QAT wave docs
(all four manifests' sizes, RAM floors, ranks, thinking flags, licenses, URLs, hashes match
`model-policy.md`, `model-benchmarks.md` §9.3, README, DRIVE-NOTICES.md); the DEP-1/DEP-2 dependency
versions (electron 39.8.10 with `electronVersion` in sync, tar 7.5.21, js-yaml 4.3.0, fast-uri 3.1.4,
dompurify 3.4.12, brace-expansion patched) match `package-lock.json` and the CHANGELOG Security bullets;
the EP-1 record vs implementation (17 `evidence:*` channels, `REVIEW_SAVE_DEBOUNCE_MS=600`,
`PROVENANCE_CARD_CAP=24`, the print-pdf option literals) all match; the EP-1 and STR-1 §-anchor legends
all resolve; `skills-overview.md` matches the 9 `app-skills/` dirs (test-pinned); version 0.1.55 and the
BUILD_STATE budget (265 KB / under 300 KB) are consistent.

**Mismatches to fix:**

| Doc | Issue | Finding |
|---|---|---|
| `known-limitations.md:1908`, `packaging.md:180`, `architecture.md:2426`, `electron-builder.yml:139` | Present packaged OCR as "verify at release" though DEP-1 verified it broken + app-killing | **AUD-07** (Medium) |
| `data-contracts.md:205/250/268/303` | Four broken `docs/docs/…` relative links from the 2026-07-12 move | **AUD-21** (Low) |
| `model-manifests/README.md:7` | Omits the `translation/` role directory | **AUD-22** (Low) |
| `README.md:212` | "Chat models" table omits Qwen3.5 0.8B and 2B (2 of 20 downloadable) | **AUD-23** (Low) |

**Missing docs:** none material. The features shipped since the last audit (EP-1, OCR-R inline redo,
STR-1 grammar constraint) are all documented; the gap is the *stale* packaged-OCR framing (AUD-07),
not a missing doc.

**Note on the retired `_Last updated_` practice:** per the 2026-07-11 housekeeping (DOC-109), freshness
stamps were removed everywhere and are not to be reintroduced or audit-flagged — this audit did not flag
any.

---

## 4. Testing audit

**Strengths (verified, not assumed).** The suite remains trustworthy for release: real crypto, real
SQLite, injected-boundary fakes with teeth; no `.only`/`.skip`/`it.todo` (all skips are documented
env-gated `skipIf`); no raw fixed sleeps in any test added since 2026-07-17; the EP-1 additions are
strong — the renderer `computeReadyGate` is compared against main's independent `deriveReadyGate` over an
exhaustive sweep (no self-validation tautology), the HTML-injection suite pushes hostile payloads
through every content field asserting escaped-not-dropped, the export suite injects a mid-build failure
to prove atomic rollback, and `audit-ipc.test.ts` pushes sentinel-bearing review content through the
real handlers asserting it never reaches `runtime_events`. Preload mocks are typed `Partial<PreloadApi>`
inside the typecheck scope, so mock drift is compile-caught. The `ipc-lock-coverage` meta-test enrolls
the evidence module with zero exemptions.

**Weaknesses / gaps to close:**

- **AUD-06** (Medium) — the NUL/BOM nets do not cover the shipped shell scripts and drive-root
  launchers (the highest-value gap here).
- **AUD-18** (Low) — the packaged-CSP build guard degrades to a green skip on output-layout drift; add
  the CODE-46 CI positive control.
- **AUD-20** (Low) — `script-drift.test.ts` covers only the `.ps1` runtime matrix, not the `.sh` twin.
- **AUD-19** (Low) — `canonicalCoverage` has no exhaustiveness tooth against `CoverageInfo`.
- **Behaviour gaps behind the confirmed bugs:** no test covers the AUD-01 regenerate→review
  interaction, the AUD-02 lock-window admission refusal, the AUD-03 auto-start-vs-lock race, or the
  AUD-04 adopt terminal-clobber / foreign-task cases. Each fix must land with the characterization test
  named in its finding (RED before the fix).

**Over-mocking:** none systemic found — consistent with the 2026-07-11 judgment. The dedicated sweep
found the boundary fakes are injected and asserted, not stubbed to trivially pass.

---

## 5. Performance audit

The recorded hot paths re-traced clean: the CODE-4 rowid-targeted FTS triggers and every prior
perf-audit index are present (no regression); the RAG retrieval path uses a bounded query-vector LRU,
a single `IN(...)` candidate join (no N+1), and index-served keyword search; ingestion embeds in one
batch + one transaction; the OCR pipeline bounds resident PNGs to 2 with per-page byte caps; no new
unbounded caches/arrays/listeners were found; IPC payloads are all bounded.

**New inefficiencies (all Low, all on the EP-1 surface, all v0.1.53–v0.1.55):**

- **AUD-12** — O(N) serial IPC round-trips to load review chips per conversation open (the most
  worthwhile to fix — it scales with history length on a common flow).
- **AUD-13** — bulk review actions fan out into one IPC write per item with redundant per-item
  re-reads.
- **AUD-15** — synchronous multi-MB fs on the main thread during pack export (same class as the
  already-fixed F-12 image-history sync-fs; port to async).
- **AUD-14** — missing `conversation_id` index behind the delete-confirm COUNT (near-negligible today;
  cheap additive fix).

**Validation.** For AUD-12/13 add a round-trip-count assertion (spy on the IPC channel) that reddens on
the fan-out and passes on the batch; for AUD-15 assert the export uses the async path (no `*Sync` on the
export tail); for AUD-14 an EQP assertion (SEARCH not SCAN) matching the repo's `TS-5` index-name idiom.

---

## 6. Design / visual audit

Method: the real dev app driven over CDP, all eight screens captured in **both themes** via the in-app
theme control, computed styles probed against `docs/design-guidelines.md`.

**Compliant (verified):**

- **§5 dual theme** — light is the default (a fresh workspace boots light); dark applies via the real
  control; every screen renders correctly in both. The lock-screen-follows-system rule is stated in the
  copy, as documented.
- **§4.3 accent tokens** — computed `--accent` is exactly `#1b7f5f` (light) / `#57d0a4` (dark); dark
  `--bg` is the brand-exact `#0e1319` (§13); bright teal never appears as a text accent on a light
  surface. `color-scheme` is set per theme (`tokens.css:52/129`), so native scrollbars follow the
  theme.
- **§13 / §6 primary buttons** — brand-teal fill + dark-ink text in both themes; **exactly one primary
  per view** on every captured screen; sentence case throughout; no emoji; Unicode-glyph icons.
- **§6 toggles** — the `.switch-track` "on" colour is exactly `rgb(27,127,95)` = `--brand-teal-dark`
  (§6), in both themes, on both Settings and Skills.
- **§6 empty states** — headline + one line + one primary action on Chat, Documents, Translate, Images.
- **Honest-hardware guardrail** — on the 16 GB dev box the model cards correctly show
  "Braucht mindestens 20 GB RAM — dieser Computer hat etwa 16 GB."

**Findings:**

- **DV-1 (Low) — native `<select>` controls bypass the token system.** The Models context-size picker
  (`ModelsScreen.tsx:826`) and the Translate language-bar selects (`TranslateScreen.tsx:417`, `:443`)
  carry no CSS class; computed style shows UA defaults — font **Arial** (not `--font-sans`),
  `border-radius: 0` (not `--radius-sm`), UA border/background rather than `--border-strong`/`--surface`.
  Only `.review-relation select` (`styles.css:2023`) is styled. Violates §6 Inputs + §4.4 typography, in
  both themes. *Fix:* a shared `select` treatment reusing the review-relation rules.
- **DV-2 (Low / UX) — the model picker leads with un-runnable models when no recommendation exists.**
  On a fresh workspace with no benchmark result, the picker lists alphabetically, so a 16 GB machine
  sees "Gemma 4 26B A4B" (≥20 GB warning, not downloaded) and the 26B/31B QAT models first; the runnable
  tier picks (Qwen3 4B, etc.) are card 12+ of 28, below the fold. The `recommendModelIdByRam`
  ranked-only guard governs the *recommender*, not display order. *Fix:* runnable-first or ranked-first
  ordering when no recommendation is available.
- **DV-3 (Info, known) — live sighting of the CODE-25 quote residual.** The Images empty-state hint
  renders `Durchsuchbar machen (OCR)"` — an opening `„` closed with an ASCII `"`. This is the
  fix-when-touched residual recorded in BUILD_STATE §5 item 11 (CODE-25 was scoped, ~7 older closers
  left); reported only to confirm the residual is real, not as a new finding.
- **DV-4 (Info) — Skills auto-fire card duplicates its label.** The card `h2` and the switch label are
  the identical string "Passenden Skill automatisch anwenden." Minor copy redundancy; arguably
  intentional (the switch needs its own a11y label). No action required.

---

## 7. Phased remediation plan

Each phase is independent and sized for a fresh session. Every implementation phase lands its fix
**RED→GREEN** with the named characterization test and updates the affected docs.

### Phase A — Evidence-review data-loss guard (AUD-01) — **do first**
- **Goal:** the "Answer without it" undo can never silently destroy an evidence review.
- **Scope/files:** `chat.ts` (`deleteLastAssistantMessage` / `withRegenerateGuard` seam),
  `chat-stream.ts`, `registerRagIpc.ts`; `renderer/chat/Transcript.tsx` + `ChatScreen.tsx` for the
  affordance gate; `evidence-reviews.ts` for a `hasReviewForMessage` helper.
- **Steps:** (1) main-side — before the delete, if the target message has a review, refuse with a
  localized "reopen or delete the review first" (mirror the D-2 posture); cover the chat channel too
  (regenerate=true is caller-supplied). (2) renderer — hide/confirm the undo when `reviewSummaries` has
  an entry for that message. (3) EN+DE copy.
- **Tests:** the two integration repros in AUD-01 (RED first). **Docs:** EP-1 record §2/§8, user-guide.
- **Acceptance:** clicking undo on a reviewed answer refuses (or preserves the review); a failed
  regenerate restores answer **and** review. **Rollback:** pure additive guard; revert the guard.

### Phase B — Lock-in-progress latch (AUD-02 + AUD-03) — **do second**
- **Goal:** nothing user-derived starts or respawns after Lock now begins.
- **Scope/files:** `workspace-vault.ts` (`beginLock()`/`isLocking()`), `registerWorkspaceIpc.ts`
  (arm first), every `requireUnlocked` + `DocTaskManager.startDocTask` + `TranslateJobService.start` +
  `VisionService.analyze` + the import loop + `registerModelIpc.startModelRuntime` (re-check
  unlocked/not-locking after `computeInstallState`).
- **Steps:** (1) add the latch, armed as the lock handler's first act, cleared only on lock failure.
  (2) route the content-surface guards + the model auto-start re-check through it. (3) capture an
  unlock epoch for the auto-start micro-window.
- **Tests:** the AUD-02 integration test (fresh admission refused during a parked teardown) and the
  AUD-03 core-model-ipc test (no `runtime.start` after a lock parked on the hash). **Docs:**
  `security-model.md` lock section, `architecture.md` §2876 assertion reconciled.
- **Acceptance:** both races fail closed; existing lock/unlock tests stay green. **Rollback:** the latch
  is additive; the CODE-2 accepted residual is unaffected.

### Phase C — Translate adopt fix (AUD-04)
- **Goal:** `adoptActiveFileTranslation` honours its documented terminal-no-op and reload-only scope.
- **Scope/files:** `renderer/lib/fileTranslateSession.ts`, `tests/renderer/fileTranslateSession.test.ts`.
- **Steps:** guard `if (snapshot.state !== 'idle') return`; add the foreign-task check via
  `getActiveDocTask`. **Tests:** the two missing cases (terminal-clobber, foreign-task). **Docs:** none.
- **Acceptance:** a held done result and a Documents-row translation both survive navigation.
  **Rollback:** revert the guard.

### Phase D — Provisioning-script robustness (AUD-05 + AUD-24)
- **Goal:** the `.ps1` best-effort/continue paths behave like the canonical `.sh` siblings.
- **Scope/files:** `scripts/fetch-runtime.ps1`, `prepare-drive.ps1`, `fetch-models.ps1`; optionally
  `script-drift.test.ts`.
- **Steps:** replace tolerant-path `Write-Error` with `Write-Host -ForegroundColor Red` + explicit
  `exit` (restore exit-2); wrap `prepare-drive`'s `&` child calls; delete-before-redo in the mismatch
  path; check whether the whisper win URL is a live asset. **Tests:** the two manual repros in AUD-05;
  a drift/behaviour guard if feasible. **Docs:** none (behaviour matches the documented intent).
- **Acceptance:** a transient failure warns-and-continues; `-Family ocr` attempts all files.
  **Rollback:** script-local.

### Phase E — Hygiene-net + drift coverage (AUD-06 + AUD-18 + AUD-20)
- **Goal:** the shipped byte-0-sensitive artifacts and the packaged-CSP guard are actually enforced.
- **Scope/files:** `repo-hygiene.test.ts`, `csp-build-output.test.ts`, `script-drift.test.ts`.
- **Steps:** add `sh|ps1|cmd|command` to both hygiene filters + `launchers/` to both roots; add the
  CODE-46 CI positive control to the CSP guard; extend script-drift to the `.sh` matrix. **Tests:** the
  nets themselves (plant-and-revert teeth). **Docs:** none.
- **Acceptance:** a planted BOM'd launcher reddens; the CSP guard fails on CI if the build is absent.
  **Rollback:** test-only.

### Phase F — Evidence-review performance batch (AUD-12 + AUD-13 + AUD-14 + AUD-15)
- **Goal:** remove the per-conversation-open IPC fan-out, the per-item bulk fan-out, the sync export
  stall, and the missing index.
- **Scope/files:** `registerEvidenceReviewsIpc.ts`, `evidence-reviews.ts`, `ChatScreen.tsx`,
  `reviewSession.ts`, `export.ts`/`print-pdf.ts`, `db.ts`.
- **Steps:** batch summary IPC; batched bulk-action transaction; async export fs twins; additive index.
  **Tests:** round-trip-count assertions + the EQP SEARCH assertion. **Docs:** the perf record.
- **Acceptance:** one round-trip per conversation open; export off the main thread. **Rollback:**
  per-change.

### Phase G — Evidence-pack / PDF-export polish (AUD-08, AUD-16, AUD-17, AUD-09, AUD-10, AUD-11)
- **Goal:** correct the source-context double-render, the swallowed cleanup, the concurrent-export
  swap, and the three review-UI a11y/i18n nits.
- **Scope/files:** `evidence-pack/source-context.ts`, `print-pdf.ts`, `renderer/review/*`, i18n
  catalogs. **Tests:** two-adjacent-chunk de-overlap; a concurrent-export provenance test; the a11y
  state reconciliations. **Docs:** `security-model.md:381` residue note.
- **Acceptance:** no duplicated context; cleanup failures logged; concurrent exports can't swap
  provenance. **Rollback:** per-change.

### Phase H — Documentation reconciliation (AUD-07 + AUD-21 + AUD-22 + AUD-23)
- **Goal:** the docs stop understating the packaged-OCR crash and stop pointing at dead links.
- **Scope/files:** `known-limitations.md`, `packaging.md`, `architecture.md:2426`,
  `electron-builder.yml` comment, `data-contracts.md`, `model-manifests/README.md`, `README.md`;
  extend the DOC-1 hygiene link-check to `docs/*.md`. **Tests:** the extended link-check. **Docs:** this
  is the docs.
- **Acceptance:** packaged-OCR reads as a verified crash + registered fix; zero broken relative links in
  `docs/`. **Rollback:** docs-only. (Cheap and low-risk — can run any time.)

### Phase I — Maintainability & design polish (AUD-19 + AUD-25 + AUD-26 + DV-1 + DV-2)
- **Goal:** exhaustiveness tooth, dead-export prune, CI Node alignment, select-token styling, picker
  ordering.
- **Scope/files:** `freshness.ts`; dead-export prune across `src` (keep the documented `nodeVectorSearch`
  fallback); `.github/workflows/ci.yml` (Node 24 + corepack); `styles.css`/`ModelsScreen`/`TranslateScreen`
  select styling; the picker sort. **Tests:** keys-parity for `canonicalCoverage`; a
  token-contrast/`select` visual check if desired. **Docs:** design-guidelines note if the select
  treatment is codified. **Acceptance:** CI runs the pinned npm/Node; selects use the tokens.
  **Rollback:** per-change.

---

## 8. Recommended execution order

1. **Phase A (AUD-01)** — the only data-loss finding; one click from the review chip; do it first and
   alone.
2. **Phase B (AUD-02 + AUD-03)** — the lock-contract races; one shared latch retires both plus the
   accepted CODE-2 residual. Independent of A.
3. **Phase C (AUD-04)** — self-contained renderer fix; can run in parallel with A/B.
4. **Phase D (AUD-05 + AUD-24)** and **Phase E (AUD-06 + AUD-18 + AUD-20)** — the provisioning/tooling
   fixes; independent of the app-code phases, good candidates to parallelise. E's hygiene-net widening
   protects the very artifacts D fixes, so pairing them is natural.
5. **Phase F (perf)** then **Phase G (pack/export polish)** — both on the EP-1 surface; F first (it
   touches the IPC shape G's tests may assume), though they are largely independent.
6. **Phase H (docs)** — cheap, low-risk, no code dependency; can slot in any time, ideally alongside
   whichever wave next touches OCR/packaging so AUD-07 lands with fresh context.
7. **Phase I (maintainability/design)** — lowest urgency; fold into the next UI or CI-touching wave.

**Dependencies:** B should precede any future work that assumes the lock contract holds (it makes
`architecture.md:2876`'s "sidecars only start post-unlock" true). F's batched IPC channel should land
before G's export tests if they assert round-trip counts. Everything else is independent.

---

## Appendix — audit provenance

- **Baseline:** `master` `bbf26add` (v0.1.55), suite ~4680/50 across 334 files.
- **Finders:** 8 personas, parallel, dedup-indexed. **Verification:** 28 candidates → 26 confirmed
  (0 Critical / 0 High), 1 refuted, 1 duplicate-of-known; every code-behaviour claim independently
  traced or reproduced, with blast radius + shipped-tag attribution.
- **Design pass:** live app over CDP, 8 screens × 2 themes, computed-style probes vs
  `design-guidelines.md`.
- **Dedupe basis:** `architecture.md` §46–§50 + OCR-R ledger, `known-limitations.md`, `BUILD_STATE.md`
  §5/§6/§8, open issues #2/#21/#48/#53/#80/#82. No finding already recorded there is reported except the
  explicitly-labelled live sightings (DV-3, and the engine-download quit residual under §2).
