# Translation feature — follow-up audit (2026-07-06) + fix plan

> **Status: OPEN — findings unremediated.** This is a working paper (CLAUDE.md doc-lifecycle
> rule): when the FA wave below is fully implemented, fold the outcomes into
> `docs/architecture.md` "Translation sidecar — design record" (a "Follow-up audit (FA wave)"
> bullet + outcomes paragraph, the TA-wave template) and DELETE this file (git history keeps it).

## Scope and relation to the TA wave

A fresh audit of the as-built TranslateGemma translation feature, run the same day the
**TA wave** (translation audit, TA-1…TA-7) closed. It covers the full surface: the sidecar
runtime (`services/translation/runtime.ts`), SSE reader (`completion.ts`), prompt builder
(`prompt.ts`), window planner (`doctasks/translation.ts`), doc-task handler
(`doctasks/handlers/translation.ts`), view-job service (`translation/jobs.ts`), IPC
(`registerTranslateIpc.ts`), both renderer stores (`translateSession.ts`,
`fileTranslateSession.ts`), the screen/drop-zone, and the lock/quit seams.

Items already recorded in the TA wave's **deferred backlog** (architecture.md, "Translation
sidecar" record) are deliberately NOT re-reported here. Everything below is new.

**Verified-solid (checked, no finding):** teardown/lifecycle state machine (single-flight
teardown, crash recovery + identity guard, double-load await); SSE terminal-frame + abort
contract; TG-6 window math re-derived at ctx 4096 (~1,860 worst-case input + 2,071 output cap
≤ 4096, D4 clamp binds correctly); lock/quit ordering (jobs aborted before the sidecar dies);
IPC validation on both ends; content-free logging; renderer generation/latch guards; the
empty-document path fails friendly (`extractSegmentTexts` → `documentNotReady`);
`ctx.translateJobs` is the same instance IPC uses, so the lock purge reaches the real job map.

---

## Findings

### F-1 (HIGH/MEDIUM, correctness) — view-job retry duplicates already-streamed text into the final output ✅ FIXED (FA-1)

> **Fixed in FA-1.** `jobs.ts` `run()` now checkpoints `job.text` after the `'\n\n'` window
> separator (post-separator, before the attempt loop) and restores that checkpoint via `patch()`
> before each retry attempt (`attempt > 1`) — so a transiently-failed attempt's streamed deltas
> are rolled back and the window appears in the terminal `done` text exactly once; the `patch()`
> cancelled-guard keeps a mid-flight-cancelled job from being resurrected by the restore. No new
> IPC (trDone already carries the full text; the renderer replaces its output with it). Pinned by
> two new integration tests in `translate-ipc.test.ts` (retry-then-success single-window +
> multi-window join-intact), confirmed RED before the fix.


`apps/desktop/src/main/services/translation/jobs.ts` — `run()` window loop (~L135–182),
terminal text (~L188).

The TA-5 M7 retry re-runs a window that came back empty, truncated, or throwing. But a
truncated or mid-stream-failed attempt has **already streamed its deltas** through
`onToken` → `emitDelta`, which appends them to `job.text` AND forwards them to the renderer.
The retry appends the whole window **again**; there is no rollback, and the terminal `done`
resolves the accumulated `job.text` — so the duplication persists into the final result the
user copies. Silent output corruption, the exact honesty class the TA wave was closing.

- **Trigger:** a transiently failed attempt that streamed partial output
  (`IncompleteStreamError` on a server-side close, a per-request timeout mid-decode, an M1
  crash-recovery) followed by a **successful** retry.
- **Immune:** the doc-task path (`translateWithRetry` passes no `onToken`; it uses only the
  resolved value, discarding the failed attempt).
- **Test gap:** `translate-ipc.test.ts` pins retry-then-**fail** only (~L166–185);
  retry-then-**success** is untested — which is how this slipped through TA-5.
- **Fix sketch:** checkpoint `job.text` before each window; restore the checkpoint before a
  retry attempt. The live view may briefly show the duplicate, but `trDone` carries the full
  text and the renderer already replaces its output with it (`translateSession.ts` done
  handler), so the final state self-heals with no new IPC.

### F-2 (MEDIUM, efficiency/latency) — retrying a deterministic limit-stop is futile and doubles a ~30-minute window ✅ FIXED (FA-2)

> **Fixed in FA-2.** Both retry loops now classify the failed attempt before retrying: a THROW or an
> EMPTY reply is the TRANSIENT class (server-side close, per-request timeout, M1 crash-recovery) and
> is retried once; a NON-EMPTY reply that did not stop cleanly (`out.length > 0 && !isCleanStop(final)`)
> is a DETERMINISTIC temperature-0 limit-stop and fails immediately — greedy decode with `cache_prompt`
> reproduces the identical truncation, so the second decode was pure waste (up to ~30 min per window).
> `translateWithRetry` (doc-task) returns `null` on the limit-stop (mark now); `jobs.ts` (view) sets a
> `limitStop` flag that breaks the attempt loop → `fail(runtimeFailed)`. The abort-propagation contract
> is byte-identical (the limit-stop returns only after the existing `signal.aborted` re-check). Pinned by
> flipping the two truncation tests from 2 calls to 1 (`translate-ipc.test.ts`, `doctasks-translation.test.ts`);
> the throw/empty tests stay at 2 calls (transient class still retries). The FA-1 multi-window rollback
> test was retargeted from a limit-stop trigger to a throw so it keeps exercising F-1 under the new policy.

Both consumers: `doctasks/handlers/translation.ts` `translateWithRetry` (~L53–87) and
`translation/jobs.ts` window loop (~L147–176).

The sidecar decodes at `temperature 0` (greedy) with an identical prompt and `cache_prompt`.
A window that hit the output cap or a greedy repetition loop (M6's "limit stop") reproduces
essentially identically on retry — so the retry burns another full decode (up to ~30 min per
window at the measured 1.1 tok/s CPU floor) to reach the same marked-window /
`runtimeFailed` outcome. Retry is right for **throws** and **empty** replies (transient);
for a clean non-empty limit-stop it should skip straight to the failure path.

- **Fix sketch:** distinguish the failure classes in both retry loops: retry on throw/empty;
  do NOT retry when `out.length > 0 && !isCleanStop(final)` (deterministic truncation).
  Halves worst-case latency on exactly the slowest windows.
- **Note:** keep the one retry for the doc-task's *thrown* windows unchanged (that is the
  transient class M1's crash recovery feeds).

### F-3 (MEDIUM, robustness/UX) — the document path has no reload recovery; the text path does

`apps/desktop/src/renderer/lib/fileTranslateSession.ts` (whole store) vs
`translateSession.ts` `adoptActiveJob()` (~L253–270).

A full renderer reload mid document-translation kills the module store and its poll timers
while the doc-task keeps running in main. The Translate screen comes back **idle** — no
progress, no Stop, no result load — and a new attempt is refused with `docTaskBusy` until the
invisible task finishes. (The translation still materializes into Documents, so nothing is
lost; it is a dead-end UX asymmetry.)

- **Fix sketch:** an `adoptActiveFileTranslation()` on screen mount, mirroring
  `adoptActiveJob`: read the active doc-task (the manager already exposes active-task state
  over `getDocTask`/the doc-tasks IPC), and when it is a running `translation` task, seed
  `state:'translating'`, `fileName` unknown-tolerant, and resume the poll loop with a fresh
  generation. Cross-check the text-path adopt guards (a text job and a file adopt must not
  both claim the panel).

### F-4 (LOW, resource leak) — `destroyed`-listener never detached for cancelled jobs ✅ FIXED (FA-1)

> **Fixed in FA-1.** `registerTranslateIpc.ts` now keeps a `jobId → detach` map; `detach()` also
> clears its own map entry. The listener is detached on the cancel terminals that emit neither
> done nor error: the `translateCancel` handler consults the map by jobId (reaching the original
> sender even though cancel is invoked with a fresh event), and the destroyed-cancel path calls
> `detach()` after `jobs.cancel`. Pinned by a new cancel-detaches-listener test (parity with the
> TA-6 done-detach test) asserting `listenerCount('destroyed')` drops to 0 on cancel.


`apps/desktop/src/main/ipc/registerTranslateIpc.ts` (~L59–86).

`detach()` runs only through `emit.done`/`emit.error` — but a **cancelled** job never emits
either (`cancel()` returns over the invoke; the aborted `run()` exits through the cancel
path, which deliberately does not emit). Each Stop-cancelled translation leaves one
`once('destroyed')` listener on the sender; a long-lived window doing start/Stop cycles
accumulates them to Node's `MaxListenersExceededWarning` at 11 — the exact noise the TA-6 L3
detach was built to avoid. Functionally harmless (the closures are idempotent cancels).

- **Fix sketch:** detach on the cancel terminal too — a `jobId → detach` map consulted by
  the `translateCancel` handler AND by the job's own cancel path (or a terminal-state
  callback from `TranslateJobService`). Extend the existing detach test with a
  cancel-detaches case.

### F-5 (LOW, hardening) — control-token sanitization covers only the two turn markers ✅ FIXED (FA-2)

> **Fixed in FA-2.** `sanitizeSourceText` now rewrites the full Gemma special-token family —
> `<start_of_turn>`, `<end_of_turn>`, `<bos>`, `<eos>`, `<unk>`, `<pad>`, `<start_of_image>`,
> `<end_of_image>` — to the same visually-identical non-token spelling (`⟨…⟩`, U+27E8/U+27E9). The
> regex (`GEMMA_SPECIAL_TOKEN_RE`) is an exact-marker alternation, so ordinary `<div>`/`<b>` HTML and
> marker-lookalike tags (`<bosch>`) stay untouched. A `TODO(smoke)` note asks the next manual
> `translategemma-smoke` to reconfirm the family against the pinned GGUF's tokenizer config; the list
> ships defensively from the Gemma-3 model card meanwhile (the same posture TA-4 M4 took). Pinned by a
> per-marker sanitize unit test + the ordinary-`<…>`-untouched invariant in `translation-prompt.test.ts`.

`apps/desktop/src/main/services/translation/prompt.ts` `GEMMA_TURN_MARKER_RE` /
`sanitizeSourceText` (~L69–83).

llama-server parses **all** special tokens in the `/completion` prompt, so a document
containing a literal `<eos>`, `<bos>`, `<unk>`, `<pad>`, or the Gemma-3 image markers
(`<start_of_image>`/`<end_of_image>`) still tokenizes to real control tokens. Not a
turn-forgery escape (TA-4 M4 closed that), but a stray mid-prompt BOS/EOS can degrade that
window's output for no reason.

- **Fix sketch:** widen the rewrite regex to the full Gemma special-token family (same
  `⟨…⟩` non-token spelling). Keep it to the exact known markers so ordinary `<…>` HTML/code
  stays untouched; extend the prompt snapshot/sanitize unit tests.

### F-6 (LOW, correctness edge) — untargeted `cancelDocTask()` can cancel a foreign task

`apps/desktop/src/renderer/lib/fileTranslateSession.ts` supersede-cancel (~L311) and
`cancelFileTranslation` (~L381–383).

Both cancel whatever task is currently active. Two narrow windows where that is not
necessarily *our* task: (a) the supersede-cancel after Stop + an immediate new start whose
task already took the lane; (b) a Stop landing in the ≤400 ms poll gap after our task went
terminal and another screen's task took the lane. Self-announcing (the other task shows
`cancelled`) but wrong.

- **Fix sketch:** a jobId-targeted cancel IPC (`cancelDocTask(jobId?)`, active-task fallback
  for old callers) — the store already holds `started.jobId`. Backend: manager cancels only
  when the given id IS the active task.

### F-7 (LOW, availability) — a transient start failure permanently disables translation for the session

`apps/desktop/src/main/services/translation/runtime.ts` `ensureStarted` catch (~L280–286).

Any non-bind-race start error arms the permanent `startFailed` latch (the reranker
precedent). For a ~10 GB model the most likely start failure is transient memory pressure
from the co-resident chat model — and that latches translation off until app restart, with
only "runtime failed" to show for it.

- **Fix sketch (pick one, decide at implementation):** (a) classify OOM-shaped start
  failures as non-latching (like bind races); (b) time-bound the latch (retry eligible after
  N minutes); (c) leave the latch but surface a distinct error code so the UI can say
  "restart the app / free memory". (a) needs a reliable OOM signature across OSes — verify
  against `LlamaServer`'s start-error surface before choosing.

### F-8 (NIT, cosmetic) — file progress label counts the materialize step

`fileTranslateSession.ts` (~L328): the label shows `stepsDone/stepsTotal`, and
`stepsTotal = windows + 1` (the materialize step) — a 12-window document reads
"Translating… (3/13)". Either subtract the materialize step for display or rename the copy
to "steps".

---

## Fix plan — the FA wave (4 phases)

Ordering: user-visible correctness first (FA-1), then the retry policy + hardening pair that
shares the same seams (FA-2), then the renderer/doc-task seam work (FA-3), then the low
sweep + close-out (FA-4). Each phase ends with the CLAUDE.md per-phase ritual: `npm test`,
`npm run typecheck`, `npm run build` green; affected `docs/` updated; `BUILD_STATE.md`
updated; commit referencing the phase.

### FA-1 — view-job output integrity + cancel-detach (F-1, F-4)

The only silent-output-corruption path left, plus the small IPC leak in the same flow.

1. **F-1:** in `jobs.ts` `run()`, snapshot the job's accumulated text before each window's
   attempt loop; before attempt 2, restore the snapshot (a `patch`-level rollback that
   respects the cancelled guard). The window separator (`'\n\n'` for `i > 0`) belongs to the
   checkpoint (emitted once, before the attempts), so rollback must restore *post-separator*
   text.
2. **F-4:** detach the `destroyed` listener on the cancel terminal (jobId→detach map in
   `registerTranslateIpc`, invoked from `translateCancel` and — via a service terminal hook
   or the cancel return path — from the aborted-run cancel).
3. **Tests:** (a) integration retry-then-SUCCESS: attempt 1 streams a partial then throws
   `IncompleteStreamError` (or reports a limit stop), attempt 2 succeeds → assert the final
   `done.text` contains the window exactly ONCE (this is the F-1 regression pin — it fails
   red before the fix); (b) cancel-detaches-listener in `translate-ipc.test.ts` (parity with
   the TA-6 done-detach test).

**Exit:** a transiently-failed-then-retried window never duplicates text in `done`;
cancelled jobs leave no `destroyed` listener behind.

### FA-2 — retry policy + sanitization widening (F-2, F-5)

1. **F-2:** in BOTH retry loops (`handlers/translation.ts` `translateWithRetry`,
   `jobs.ts` window loop), classify the failed attempt: retry on **throw** or **empty**;
   fail immediately (no retry) on **non-empty + non-clean-stop** (deterministic limit-stop).
   Keep the abort-propagation contract byte-identical.
2. **F-5:** widen `sanitizeSourceText` to the full Gemma special-token set
   (`<bos>`, `<eos>`, `<unk>`, `<pad>`, `<start_of_image>`, `<end_of_image>` — verify the
   exact family against the pinned GGUF's tokenizer config at the next manual smoke; ship
   the list defensively meanwhile).
3. **Tests:** scripted-translator limit-stop → exactly ONE call (no futile retry) in both
   the doc-task and view suites (adjust the TA-5 tests that currently assert 2 calls for the
   truncation shape — the 2-call assertion stays for throw/empty); sanitize unit tests for
   each new marker + the ordinary-`<…>`-untouched invariant.
4. **Docs:** `known-limitations.md` translation section (retry semantics: transient
   failures retried, deterministic truncation marked/failed immediately);
   `security-model.md` unchanged (no new log content).

**Exit:** a limit-stop window costs one decode, not two; embedded literal special tokens
tokenize as plain text.

### FA-3 — file-path reload adoption + targeted cancel (F-3, F-6)

1. **F-6 first (it is a dependency of clean adoption):** add jobId-targeted cancel —
   IPC `cancelDocTask(jobId?)` (absent id keeps today's active-task behavior for existing
   callers), manager cancels only if the id matches the active task; thread the held
   `started.jobId` through `fileTranslateSession`'s two cancel paths.
2. **F-3:** `adoptActiveFileTranslation()` in `fileTranslateSession.ts`, called from the
   Translate screen's mount effect alongside `adoptActiveJob()`: query the active doc-task;
   when it is a running `translation` task, seed `translating` state (+ windows progress
   from its status; `fileName` may be unavailable after reload — tolerate null) and resume
   the doc-task poll with a fresh generation. Define precedence with the text-path adopt
   (file adopt wins the panel iff a translation doc-task is active; both active is
   impossible — D9 lane).
3. **Tests:** renderer `fileTranslateSession` adopt cases (running task adopted → polls to
   done → result loads; no task → no-op; non-translation task → no-op); targeted-cancel
   integration (stale cancel with an old jobId does NOT kill the newer active task — the F-6
   race pin).

**Exit:** a renderer reload mid document-translation resumes progress/Stop/result in the
Translate view; a stale cancel can never kill a foreign task.

### FA-4 — start-latch decision, nit, docs, close-out (F-7, F-8)

1. **F-7:** decide (a)/(b)/(c) from the finding (needs a look at `LlamaServer`'s real
   start-error surface; if no reliable transient signature exists, ship (c) — the distinct
   error code + UI copy — and record (a) as rejected-with-reason).
2. **F-8:** display-side fix for the window-count label (subtract the materialize step or
   reword the key).
3. **Close-out (doc-lifecycle rule):** fold the FA-wave outcomes into `docs/architecture.md`
   "Translation sidecar — design record" (an "FA wave — outcomes" paragraph + per-finding
   disposition), update `known-limitations.md` if F-7 ships as (c), then **DELETE this
   file**. Update `BUILD_STATE.md` with the wave-complete entry.

**Exit:** every F-1…F-8 either fixed or decided-with-record; this working paper deleted.

---

*Method note: findings were verified against the code on `master` (2026-07-06, post-TA-7);
line references are approximate anchors, not exact pins. Suite at audit time: 3505 pass /
47 skip.*
