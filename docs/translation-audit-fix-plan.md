# Translation audit — fix plan (TA wave)

**Created:** 2026-07-06. **Source:** [`docs/translation-audit-2026-07-06.md`](translation-audit-2026-07-06.md)
(the audit of the TranslateGemma wave TG-1…TG-6). **Phases:** TA-1 … TA-7, run in numeric
order. **Branching:** commits go **directly on `master`** (owner-directed 2026-07-06 — no
`fix/<wave>-<phase>` branch chain for this wave).

**Lifecycle:** this is a working paper. TA-7 folds the outcomes into the design records
and **deletes both this plan and the audit report** per the CLAUDE.md doc-lifecycle rule.

---

## How to run a phase in a fresh session (read this first)

1. Read `CLAUDE.md`, then **only the head of `BUILD_STATE.md`** (first ~40 lines — the
   file is >1 MB; NEVER read it fully), then this plan's global section + the one phase
   you are implementing. Each phase embeds everything it needs — do not re-read the
   whole audit unless a finding reference is unclear.
2. Read **only the files the phase lists**. Line anchors are as of 2026-07-06 and may
   have drifted a little — locate by the quoted identifiers, not blindly by line number.
3. Implement, then run the per-phase ritual (MANDATORY): `npm test`, `npm run typecheck`,
   `npm run build` all green → update the affected `docs/` → add a dated entry at the top
   of `BUILD_STATE.md` (status, decisions, contracts, next phase) → tick the phase's
   checkbox in **this plan** → commit.
4. **Staging discipline:** the owner runs concurrent sessions in one shared working tree
   — stage the explicit files you changed, **never `git add -A`**.
5. Commit message shape: `fix(translation): <summary> (TA-<n>)` (or `docs(translation):`
   for TA-7), ending with the standard co-author line.
6. Severity IDs (H1…H4, M1…M8, L1…L12, D1…D5) refer to the audit report's numbering; the
   relevant content is embedded below so the report is only needed as backup.

**Phase status:**
- [x] TA-1 — Main-process lifecycle seams: quit + lock (H1, H2)
- [ ] TA-2 — Renderer lock purge (H3, incl. ImagesScreen)
- [ ] TA-3 — Renderer store hardening (H4, M8, L5–L8)
- [ ] TA-4 — SSE reader + prompt hardening (M2, M3, M4, L1, L4)
- [ ] TA-5 — Stop-reason surfacing + window-failure policy (M6, M7) — depends on TA-4
- [ ] TA-6 — Sidecar runtime robustness (M1, M5, L2, L3)
- [ ] TA-7 — Low sweep, doc drift, close-out (L9, L11, L12, L10-decision, D1–D5)

---

## TA-1 — Main-process lifecycle seams: quit + lock (H1, H2)

**Files to read:**
`apps/desktop/src/main/shutdown.ts` (whole file, ~106 lines),
`apps/desktop/src/main/ipc/registerWorkspaceIpc.ts` (the `lockWorkspace` handler, ~lines 215–280),
`apps/desktop/src/main/services/doctasks/manager.ts` (queue/pump/cancel: `startDocTask`,
`cancelDocTask`, `pump`, `run`, the `TERMINAL` set),
plus the existing tests: glob `apps/desktop/tests/**/shutdown*` and
`apps/desktop/tests/**/workspace-ipc*`, and `apps/desktop/tests/integration/doctasks-translation.test.ts`
(skim for fixtures to reuse).

### H1 — quit never cancels a running translation doc-task
`performShutdown` (shutdown.ts:54–61) aborts `abortActiveBuild()` and
`translateJobs.stop()` but never `ctx.docTasks?.cancelDocTask()` — asymmetric with the
lock path. Consequence: on quit mid-translation, `translator.stop()` kills the in-flight
window, retries fail fast against the `stopped` latch, and if ≥1 window already
succeeded the handler proceeds to `materializeDocument` **during teardown** — writing a
half-translated plaintext `<jobId>.parse.md` transient racing the DB close; a hard exit
between the write and the `finally` shred leaves plaintext on the drive until the
next-launch sweep.

**Fix:** in `performShutdown`, cancel the active doc task (same call the lock path
makes) in the same best-effort try-block that aborts the build, BEFORE the sidecar
stops. Then, after the sidecar `Promise.allSettled` and next to
`awaitInFlightStreamsSettled`, await the cancelled task's SETTLE with a bounded timeout
(~5 s `Promise.race`) so the abort-unwind (which persists/cleans synchronously while the
DB is open) completes before `lock()`. The manager does not currently expose a settle
promise — add one: e.g. `DocTaskManager.awaitActiveTaskSettled(): Promise<void>` that
resolves when the current `run(task)` promise settles (resolve immediately if idle).
Keep it dependency-injectable like the rest of `ShutdownDeps`.

### H2 — lock cancels only the ACTIVE task; a queued translation runs during the lock window
`registerWorkspaceIpc.ts:236` calls `ctx.docTasks?.cancelDocTask()` (no jobId → active
task only). When the cancelled task settles, `manager.pump()` (manager.ts:392–406)
immediately dequeues the next queued task. The comment's safety claim ("still-queued
tasks fail friendly at dequeue — `getDb()` throws while locked") is **false during the
lock handler itself**: the DB is still open while the handler awaits the sidecar
suspends, so a queued translation dequeues, `extractSegmentTexts` decrypts document text
to a `.parse` transient mid-lock, and its `translateWithRetry` retry (attempt 2, after
`teardown()`'s `finally` clears `tearingDown` — runtime.ts:375) cold-starts a fresh
~10 GB sidecar that outlives the lock.

**Fix:** add `DocTaskManager.cancelAllDocTasks(): void` — cancels the running task AND
every queued one (walk `this.queue`, call the existing per-id cancel logic so each
queued poller gets a terminal `cancelled`), leaving the manager usable for new tasks
after unlock (no permanent latch; `pump` is driven per `startDocTask`). Call it from the
lock handler in place of `cancelDocTask()`, and update the now-false comment. Also await
the active task's settle (the TA-1 `awaitActiveTaskSettled`, bounded) before the sidecar
suspends, mirroring the stream-settle treatment.

**Tests (extend the existing suites, don't create new harnesses):**
- shutdown test: a fake ctx with a running translation task asserts `cancelDocTask`
  (or `cancelAllDocTasks`) is called BEFORE `translator.stop()`, and that shutdown awaits
  the settle (ordering assertion, like the existing REL-4/R1 tests).
- workspace-ipc lock test: running translation A + queued translation B → lock → BOTH end
  `cancelled`; assert B's handler never ran (e.g. a booby-trapped translator whose
  `translate` throws if called after lock began).
- manager unit: `cancelAllDocTasks` cancels queued tasks to terminal `cancelled` and
  leaves a subsequently-started task runnable.

**Docs:** `docs/security-model.md` (the lock-path description of doc tasks — it currently
mirrors the false comment), `docs/architecture.md` translation design record (a TA-1
bullet). **Exit:** ritual green; BUILD_STATE entry; commit `fix(doctasks): quit cancels
the running task; lock flushes the queue (TA-1)`.

---

## TA-2 — Renderer lock purge is dead code (H3, incl. ImagesScreen)

**Files to read:**
`apps/desktop/src/renderer/App.tsx` (the `lockNow` function ~line 157 and the
`workspace && !unlocked` gate ~line 183),
`apps/desktop/src/renderer/screens/TranslateScreen.tsx` (the `locked` state + purge
effect ~lines 115–155, and any `locked` EmptyState render),
`apps/desktop/src/renderer/screens/ImagesScreen.tsx` (~line 141 — the same dead pattern
for the vision session),
`apps/desktop/src/renderer/lib/translateSession.ts` + `lib/fileTranslateSession.ts`
(the `clearTranslateSession` / `clearFileTranslate` exports and their header comments),
and the vision session store (grep the clear function ImagesScreen imports).

### H3 — the purge can never fire
`clearTranslateSession()`/`clearFileTranslate()` are called only from a TranslateScreen
effect gated on component-state `locked`, which is set from `getAppStatus` on
mount/focus. But screens render one-at-a-time and `App.lockNow()` swaps the whole shell
to `WorkspaceGate` (unmounting every screen) as soon as `lockWorkspace` resolves — so
the effect can never observe `locked === true`. The module-level stores survive the
unmount by design. Consequences: source text, streamed translation, and the file
result's preview stay in renderer memory the whole locked period (contradicting
translateSession.ts's own header comment and security-model.md's "dropped on lock");
a mid-stream text session returns after unlock stuck `translating: true`/busy (main's
`jobs.stop()` emits no `trError`, and `adoptActiveJob` early-returns because
`activeJobId` is still set); a mid-flight file session's `setInterval` keeps polling the
locked backend until the first throw lands a stale "failed (locked)" banner.
`ImagesScreen.tsx:141` has the identical dead pattern for the vision session.

**Fix:** move the purge to where the lock actually happens:
1. In `App.lockNow()`, after `await window.api.lockWorkspace()` and next to
   `setWorkspace(next)`: call `clearTranslateSession()`, `clearFileTranslate()`, and the
   vision-session clear that ImagesScreen's dead effect calls.
2. **Check for other lock initiators**: grep the renderer for every path that can land
   the app in the locked gate (auto-lock timers, main-pushed lock events, workspace
   state polling). If one exists besides `lockNow`, hook the purge there too (or better:
   a single `purgeSessionStores()` helper in a lib module that every initiator calls).
3. Remove the now-dead `locked` purge effects (and, if confirmed dead, the `locked`
   EmptyState branches) from TranslateScreen and ImagesScreen — or rewire them to real
   signals; do NOT leave dead code claiming a defense.
4. Update the header comments in `translateSession.ts:21-23` (and the fileTranslate
   equivalent) that say "on workspace LOCK the screen calls clearTranslateSession()" to
   name the real caller.

**Tests:** an App-level test (extend the existing App/lock test if present — glob
`tests/renderer/**App*` / grep `lockNow`) asserting: seed both translation stores (and
the vision store) non-idle → invoke the lock flow → all stores back to their EMPTY
snapshots; plus a regression for the stuck-busy shape: after purge, `adoptActiveJob`
with no active main job leaves the store idle.

**Docs:** `docs/security-model.md` "Translate view" (the lock claim now matches
reality — and the fixed wording should describe the App-level purge). **Exit:** ritual
green; BUILD_STATE entry; commit `fix(renderer): purge translation/vision session stores
at the real lock seam (TA-2)`.

---

## TA-3 — Renderer store hardening (H4, M8, L5–L8)

**Files to read:**
`apps/desktop/src/renderer/lib/fileTranslateSession.ts` (whole file, ~400 lines),
`apps/desktop/src/renderer/lib/translateSession.ts` (whole file),
`apps/desktop/src/renderer/screens/TranslateScreen.tsx` (`onCopy` ~line 204,
`onTranslate` ~157–175, `onDropFiles` ~line 181),
`apps/desktop/src/renderer/translate/TranslateDropZone.tsx` (whole file, small),
tests `apps/desktop/tests/renderer/fileTranslateSession.test.ts` +
`translateSession.test.ts` + the TranslateScreen test file.

### H4 — `pollInFlight` latch is shared across generations and force-released
fileTranslateSession.ts: the reentrancy latch (module-level `pollInFlight`, ~line 92) is
reset by `stopPolling()` (~line 114) while a superseded callback's IPC round-trip is
still in flight, and each callback's `finally { pollInFlight = false }` (~lines 267,
325) runs **even on the stale-generation early-return paths** — releasing a latch owned
by the NEW generation's in-flight tick. Scenario: slow `getImportJob`/`getDocTask`
round-trip → Stop → new file dropped → new tick A in flight → old callback's `finally`
frees the latch → tick B fires concurrently → both see `status.done` → double
`startTranslationTask` → the second `startDocTask` is refused (task active) → `failWith`
kills the timer the first installed, shows "failed", while the real backend task runs
unwatched (zombie holding the one-at-a-time lane, materializing a document).
**Fix:** make the latch **local to each `setInterval` closure** (a `let inFlight`
captured per timer) and delete the reset in `stopPolling()`. A stale-generation callback
then only ever releases its own timer's latch, which is already dead.

### M8 — `guardStart` not re-checked after the picker await
`pickAndTranslate` runs `guardStart()` only BEFORE `await window.api.pickDocuments(...)`
(~lines 186–201). If a text translation starts while the dialog is open (possible when
the dialog is non-modal: no focused BrowserWindow, or Linux WM behavior), `runImport`
(~line 215) calls `clearTranslateSession()` — which drops the text store's listeners and
state **without cancelling the main-side job**: the orphaned job keeps decoding, holds
the one-at-a-time lane (next Translate shows a baffling `busy`), and a later remount
re-adopts it into a both-sessions-active state.
**Fix:** re-run `guardStart()` after the await resolves with a path; on refusal, return
that outcome (e.g. `'busy'`) WITHOUT touching the text session — mirroring how a
rejected drop keeps the text result.

### L5 — Stop swallowed during the start round-trip
translateSession.ts `stopActive()` (~195–201) early-returns while `activeJobId` is null,
but the UI shows Stop as soon as `translating: true` is set (~line 156) — before the
`translateStart` IPC resolves. **Fix:** when `translating` is true but `activeJobId` is
null, bump the generation counter (the store's supersede pattern) so the start's
post-await branch sees itself superseded and cancels the just-started job — the same
treatment `cancelFileTranslation` already gives the doc-task lane.

### L6 — busy-guard asymmetry + unguarded `job.error` deref
translateSession.ts `translate()`: (a) the entry guard (~line 151) checks only
`snapshot.activeJobId`, not `snapshot.translating` (and not the file session) — align it
with `guardStart`'s cross-session check; (b) `job.error` (~line 173) is dereferenced
outside the try — a malformed/undefined bridge resolve throws, rejects the promise
(TranslateScreen's `.then` chain has no `.catch`), and leaves the store stuck
`translating` with a dead Stop. Wrap the resolve handling in the try (or guard `job`)
and ensure every failure path resets `translating`.

### L7 — `onCopy` unhandled rejection
TranslateScreen.tsx (~line 204): `copyToClipboard(...)?.then?.(...)` has no `.catch`;
add one (match the `onExport` pattern directly below).

### L8 — busy drop zone still advertises itself as a drop target
TranslateDropZone.tsx (~lines 26–50): while `busy`/disabled, `onDragOver` still calls
`preventDefault()` (OS shows a copy cursor) but `onDrop` silently discards. **Fix:** when
disabled, set `e.dataTransfer.dropEffect = 'none'` and don't `preventDefault()` (so the
OS shows no-drop), or surface the existing busy banner on a discarded drop. While in the
file: also gate the drag-over affordance on `e.dataTransfer.types.includes('Files')`
(non-file drags currently light it up — audit "improvements", cheap here).

**Tests (this phase closes audit test-gap #2):**
- fileTranslateSession: slow-round-trip double-fire regression for H4 (fake timers +
  a `getImportJob` that resolves after Stop + re-drop; assert exactly ONE
  `startDocTask`); M8 interleave (text job starts during the pick await → outcome
  `'busy'`, text session untouched); doc-task terminal `failed` and `cancelled`
  statuses; `getImportJob`/`getDocTask` rejection → `failWith(friendly…)`;
  `previewDocument` throwing; `completed === 0`.
- translateSession: Stop during the start round-trip cancels the job (L5); malformed
  `translateStart` resolve doesn't wedge the store (L6).
- TranslateScreen/DropZone: busy drop gives feedback, non-file drag doesn't highlight;
  keyboard activation still works.

**Docs:** none beyond BUILD_STATE (behavior-preserving hardening). **Exit:** ritual
green; commit `fix(renderer): translation store hardening — per-timer poll latch,
post-picker guard, stop/error edges (TA-3)`.

---

## TA-4 — SSE reader + prompt hardening (M2, M3, M4, L1, L4)

**Files to read:**
`apps/desktop/src/main/services/translation/completion.ts` (whole file, ~130 lines),
`apps/desktop/src/main/services/translation/prompt.ts` (whole file, ~97 lines),
`apps/desktop/src/main/services/translation/runtime.ts` (`runTranslate` + the fetch/SSE
consumption, ~lines 289–332),
`apps/desktop/src/main/services/translation/index.ts` (the `Translator` contract),
test `apps/desktop/tests/integration/translation-runtime.test.ts` (its fake-server SSE
fixtures) and `tests/unit/translation-prompt.test.ts` (the prompt snapshot — it WILL
need updating if the prompt changes).

### M2 — a stream ending without the terminal `stop:true` frame counts as success
`readCompletionSSE` treats reader `done` with no final frame as normal termination
(completion.ts:100–101 `if (done) break` → flush ~115–121); `runTranslate` resolves the
accumulated partial as the full translation. A server-side close mid-decode therefore
yields a silently truncated "success" — the view emits `trDone` with cut text, and the
doc-task handler accepts any non-empty output and **materializes a truncated document**.
**Fix:** track `sawFinal`; if the stream ends without it (and without the caller's
abort), throw a retryable error (a `CompletionError` subtype or a dedicated
`IncompleteStreamError`) so both consumers hit their existing retry/failure paths.

### M3 — `error:`-field SSE events are dropped
`parseCompletionLine` only handles `data:` lines (completion.ts:55–56). Upstream
llama.cpp can emit mid-stream failures as an `error: {…}` SSE field line; if the pinned
b9849 does, the error is swallowed and M2's shape turns a hard server error into silent
truncation. **Fix:** recognize `error:`-prefixed lines too and map them to
`CompletionError` (same payload shape). Add a note to the manual smoke
(`tests/manual/translategemma-smoke.test.ts`) TODO list to confirm the pin's actual
error framing at the next smoke run — do not block this phase on drive access.

### M4 — Gemma control-token forgery via source text
`buildTranslationPrompt` interpolates the source text raw (prompt.ts:96), and
llama-server tokenizes string prompts with special-token parsing — a document containing
literal `<end_of_turn>` / `<start_of_turn>user …` forges a turn boundary, so the D2
"embedded instructions are translated, never obeyed" guarantee only covers plain-text
imperatives. **Fix:** sanitize `text` in `buildTranslationPrompt` — neutralize the Gemma
turn markers (e.g. replace `<start_of_turn>` / `<end_of_turn>` with a visually-identical
non-token spelling such as inserting a zero-width or escaping the angle brackets;
pick ONE, document why, keep it reversible-safe for translation fidelity — replacing
with `<start_of_turn​>` style or simply `⟨start_of_turn⟩` are both acceptable; the
translated output of such markers is already best-effort). Update the prompt snapshot
test + add cases: source containing each marker renders with no raw marker substring
except the builder's own scaffold occurrences.

### L1 — abort between token deliveries resolves partial text as success
completion.ts:99 (`if (signal?.aborted) return`) ends the generator cleanly, so
`translate()` can resolve partial output on abort, violating the `Translator` contract
("resolves with the full text"); both current consumers re-check the signal, so it's
latent. **Fix:** after the read loop in `runTranslate` (or in the generator), if
`signal.aborted`, throw the abort reason instead of resolving — matching what an
in-`read()` abort already does.

### L4 — misleading catch comment + silent garbled-frame drop
completion.ts:72–75: the catch is commented "partial frames", but the `\n`-splitter only
feeds complete lines — the only thing it swallows is a genuinely garbled frame. Fix the
comment and add a content-free warn (e.g. a counter logged once per stream:
`log.warn('translation SSE: dropped unparseable frame', { count })`) — never the frame
content (privacy rule).

**Tests (closes audit test-gap #3):** a NEW `tests/unit/translation-completion.test.ts`
unit-testing `readCompletionSSE` directly with a scripted `ReadableStream`:
multi-chunk frames split mid-line, CRLF lines, no-trailing-newline flush, terminal frame
→ `onFinal`, `data:`-error frame throws, `error:`-field line throws (M3), stream end
without final frame throws (M2), abort mid-stream throws (L1), garbled complete frame
skipped + counted (L4). Update `translation-runtime.test.ts` fixtures to send the
terminal frame (they must — otherwise M2's fix breaks them, which is the point) and add
a runtime-level "no terminal frame → retryable error" case. Update the prompt snapshot.

**Docs:** `docs/security-model.md` (the D2 injection note gains the control-token
sanitization), `docs/architecture.md` translation record (TA-4 bullet: sawFinal +
sanitization). **Exit:** ritual green; commit `fix(translation): SSE terminal-frame +
error-field handling, control-token sanitization (TA-4)`.

---

## TA-5 — Stop-reason surfacing + window-failure policy (M6, M7) — AFTER TA-4

**Files to read:**
`apps/desktop/src/main/services/translation/index.ts` (the `Translator` interface +
`TranslateOptions`), `completion.ts` (`CompletionFinal` — `stoppingWord`, `timings`),
`runtime.ts` (`runTranslate`), `jobs.ts` (the view window loop, ~lines 100–165),
`apps/desktop/src/main/services/doctasks/handlers/translation.ts` (whole file —
`translateWithRetry`, the window loop, `failedWindowNotice` usage),
tests `translate-ipc.test.ts`, `doctasks-translation.test.ts`.

### M6 — output-limit truncation is undetectable
The final frame's stop reason is surfaced only as `stoppingWord` via `onFinal`, and
NEITHER consumer passes `onFinal` — any non-empty reply counts as a clean window. A
greedy-decode repetition loop (classic MT pathology at temperature 0) that runs to the
~2,070-token window cap gets stitched mid-sentence into the persisted document silently;
the acknowledged token-dense input edge clips the same way.
**Fix:** surface the finish info to callers — extend `TranslateOptions` with
`onFinal?: (info: CompletionFinal) => void` passed through `runTranslate` (the smoke
already consumes it at the runtime layer; keep that working), OR change `translate()` to
resolve `{ text, final }` — pick the option that keeps the `Translator` interface
simplest; `onFinal` threading is the smaller diff. A window whose final frame carries
NO `stoppingWord`/eos (i.e. a limit stop) is treated as a FAILED attempt in the doc-task
handler → existing retry-then-`failedWindowNotice` path. Define the detection helper
once (e.g. `isCleanStop(final)`) next to `CompletionFinal` so both consumers share it.

### M7 — the view job silently drops an empty window
jobs.ts window loop: the doc-task's retry-then-mark policy exists only in the doc-task
handler; the view loop accepts whatever each `translate()` resolves — one transiently
empty window in a 12-window paste completes "done" with a silently missing paragraph.
**Fix:** in the view loop, retry an empty (or non-clean-stop, per M6) window once;
if still empty/truncated, fail the job with the existing `runtimeFailed` shape (the view
is interactive — a visible failure beats a silent gap; do NOT invent a new partial-result
UI). Keep the single-window fast path behavior identical for genuinely empty *input*
(already rejected as `badRequest` at start).

**Also pin (audit test-gap #4):** a test asserting a per-request **timeout**
(`TimeoutError` from the combined signal) is treated as a failed window (retry → notice)
rather than a task-level cancel — the current semantics hang on the abort reason's
*name* and nothing pins that.

**Tests:** doctasks-translation: a scripted translator whose window 2 final-frame has no
stopping word → retried once → `failedWindowNotice` for that window, others intact;
timeout-name pinning test. translate-ipc: empty-window retry then `runtimeFailed`;
clean multi-window unchanged. Manual smoke: no change needed (real model produces clean
stops; note in the smoke's header that `stoppingWord` is now load-bearing).

**Docs:** `docs/known-limitations.md` (the repetition-loop/truncation behavior is now
detected → update the translation section's honesty note), architecture record TA-5
bullet. **Exit:** ritual green; commit `fix(translation): detect limit-stop windows;
view job retries empty windows (TA-5)`.

---

## TA-6 — Sidecar runtime robustness (M1, M5, L2, L3)

**Files to read:**
`apps/desktop/src/main/services/translation/runtime.ts` (whole file, ~416 lines),
`apps/desktop/src/main/runtime/sidecar.ts` (the `LlamaServer` lifecycle — check whether
it exposes an unexpected-exit callback/event; the vision service and `runtime/factory.ts`
are precedents to grep), `apps/desktop/src/main/services/translation/jobs.ts`
(`stop()`, the `tearingDown` field, and where jobs are keyed to a sender),
`apps/desktop/src/main/ipc/registerTranslateIpc.ts` (whole file),
test `translation-runtime.test.ts`.

### M1 — a sidecar crash leaves a dead server handle until 120 s of quiet
`TranslationRuntime` never observes the child dying on its own and never clears
`this.server` (`ensureStarted` returns the cached handle, runtime.ts:226) — after a
crash every `translate()` fails with a connection error, and because each attempt
resets the idle clock's disarm/re-arm cycle, the outage persists as long as attempts
arrive < 120 s apart. **Fix (pick per what `LlamaServer` offers):** (a) if `LlamaServer`
exposes an exit callback/event (`onUnexpectedExit` or similar — check sidecar.ts), wire
it to null `this.server` (guard against clobbering a NEWER server instance: compare
identity); else (b) in `runTranslate`'s catch, detect connection-level failures
(ECONNREFUSED/socket hang up) and null `this.server` (identity-compared) so the NEXT
attempt cold-starts. Either way the doc-task's one-retry then gets a fresh spawn.

### M5 — `teardown()` is not single-flighted
runtime.ts:359–377: a concurrent teardown's `server.stop()` is untracked — a quit
`stop()` arriving while a suspend's kill is in its SIGTERM→2 s→SIGKILL window sees
`server === null` and resolves immediately (app can exit with the escalation pending →
possible orphan on POSIX); overlapping suspends let the second's `finally` clear
`tearingDown` while the first is still killing (a racing `translate()` then cold-starts
during the vault re-encrypt). **Fix:** hold a `teardownPromise` — if one is live,
`teardown()` returns/awaits it instead of starting a second pass; `tearingDown` clears
only when the SHARED promise settles (mirror the existing `idleTeardownPromise`
pattern). While here (audit "improvements", same lines): make a cold start await a live
`idleTeardownPromise` first, so a translate racing the soft teardown doesn't briefly
double-load ~10 GB.

### L2 — `TranslateJobService.tearingDown` is dead code
jobs.ts:62–68 + 230–242: `stop()` has no `await`, so the flag is set and cleared within
one synchronous block — no continuation can observe it. Remove the latch and fix the
comment (the real defense is `signal.aborted`), or make `stop()` genuinely async-safe if
TA-5 changed its shape. Don't leave a comment claiming a defense that doesn't exist.

### L3 — stream events bound to the starting `webContents` forever
registerTranslateIpc.ts:34–45: `trToken`/`trDone` go to the original sender only; if
that window is destroyed (the app has multi-window support), events drop silently, the
job decodes up to the 45-min timeout holding the busy lane, and another window adopting
via `getActive` sees a frozen snapshot. **Fix (minimal):** listen for the sender's
`'destroyed'` event and cancel the job (parity with lock behavior). A full
emitter-rebind on `getActive` is NOT required — note it as deferred if skipped.

**Tests:** runtime: crash-recovery (kill the fake server out-of-band → next translate
cold-starts — via the exit callback or the connection-error path); concurrent
`stop()`+`suspend()` resolves only after the child is dead (fake server with a slow
stop); overlapping suspends don't clear `tearingDown` early; translate during idle
teardown awaits it (no double spawn — assert spawn count). jobs/IPC: destroyed-sender
cancels the active job.

**Docs:** architecture record TA-6 bullet (crash path + single-flight teardown).
**Exit:** ritual green; commit `fix(translation): sidecar crash recovery, single-flight
teardown, sender-destroy cancel (TA-6)`.

---

## TA-7 — Low sweep, doc drift, close-out (L9, L11, L12, L10-decision, D1–D5)

**Files to read:** only what each item names below, plus
`docs/architecture.md` (the "Translation sidecar — design record" section) for the fold.

### Code lows
- **L9** — `apps/desktop/src/main/services/doctasks/translation.ts` (~94–97):
  `translationUsableTokens` clamps `contextTokens` **up** to 1024 — wrong backstop
  direction (a future manifest with a smaller real context would overflow every window).
  Make the floor a refusal or clamp the BUDGET down, never inflate past the real ctx;
  add a unit case at ctx 512 in `tests/unit/doctasks-windows.test.ts`.
- **L11** — `apps/desktop/src/main/services/doctasks/manager.ts` (~93, ~336–344):
  `tasks` map is never evicted (session-long growth) and the expired-id fallback
  hardcodes `kind: 'summary'`. Evict terminal tasks on acknowledge (or cap like
  `TRANSLATE_MAX_JOB_HISTORY`), and echo the poller's actual kind if recoverable — else
  a neutral kind. Unit-test the eviction.
- **L12** — `apps/desktop/src/main/services/doctasks/translation.ts` (~151–161):
  `failedWindowNotice` + `translationAttributionLine` are hardcoded English but
  PERSISTED into generated documents. Route both through `tMain` (en+de keys; parity is
  compile-enforced) keyed off the app language at materialization time. Update the
  integration assertions that match the English strings.
- **L10 (decision, not code)** — `approxTokenCount` under-charges glued emoji/astral
  runs, so "over-chunk, never overflow" is not absolute. **Recommended: ACCEPT** —
  touching the shared chunker for a pathological input isn't worth the blast radius;
  the failure mode is an honest failed-window notice. Document it in
  `docs/known-limitations.md` (translation section) and soften the absolute claim in the
  `doctasks/translation.ts` header comment. If the owner prefers a fix, it belongs in a
  separate chunker-owned change, not this wave.

### Doc drift (D1–D5)
- **D1** — `docs/packaging.md` (~line 417, the `translategemma-smoke` row): change
  "keeps numbers/dates/codes verbatim" → "keeps invoice numbers/model codes verbatim;
  numbers/dates localize" (the test asserts only stable identifiers verbatim).
- **D2** — `apps/desktop/tests/manual/translategemma-smoke.test.ts` (~line 46): fix the
  header leg list the same way (it contradicts its own body at ~278–288).
- **D3** — `apps/desktop/src/main/services/doctasks/translation.ts` (~line 52): reword
  "until TG-6 re-measures" → past tense ("TG-6 re-measured and kept 300").
- **D4** — `docs/security-model.md` (~425–426): extend the log enumeration to mention
  the content-free `error: String(err)` failure log.
- **D5** — stale `HILBERTRAUM_TRANSLATION_SMOKE` shape comments →
  `HILBERTRAUM_TRANSLATEGEMMA_SMOKE`: `tests/manual/categorizer-smoke.test.ts:30`,
  `compare-smoke.test.ts:40`, `whisper-smoke.test.ts:16`.

### Close-out (doc lifecycle rule)
1. Fold the WAVE's outcome into the design records: a short "Translation audit (TA wave)
   — outcomes" paragraph in `docs/architecture.md`'s translation design record (what was
   fixed per phase, one line each; decisions L10-accept and any deferred items), plus the
   security-model.md updates already made per phase.
2. Record the **deferred backlog** (below) in the architecture record or
   known-limitations as appropriate.
3. **Delete `docs/translation-audit-2026-07-06.md` AND this plan file** (git history
   keeps them); BUILD_STATE close-out entry marks the TA wave complete.

**Exit:** ritual green; commit `docs+fix(translation): low sweep, doc drift, TA-wave
close-out (TA-7)`.

---

## Deferred backlog (audited, deliberately NOT scheduled in this wave)

Improvements from the audit that are real but out of scope here — record at TA-7:
- Paste-size cap for the Translate view (multi-hour multi-window pastes).
- `GeneratedProvenance` lacks the translation language pair (data-contract addition).
- Doc-task dedup on double-clicked Translate (`hasPendingKind` generalization).
- `extractSegmentTexts` abort signal (cancel during a long encrypted-PDF re-parse).
- Mid-segment split's spurious paragraph break in doc-task output (view path already
  avoids it).
- `resolveSidecarSelection` dead `makeReal` param for the translator factory.
- Drop-zone `onDragLeave` child-element flicker; duplicate tab stops.
- File-pane live region (a11y) + partial-output indication after cancel/error.
- Full emitter rebind on `getActive` adoption across windows (if L3 shipped as
  cancel-on-destroy only).
