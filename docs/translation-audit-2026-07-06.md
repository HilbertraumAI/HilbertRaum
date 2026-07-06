# Translation feature audit — 2026-07-06

**Scope:** the TranslateGemma wave as shipped (TG-1…TG-6, closed 2026-07-05) — the
`services/translation/` sidecar, the translation doc-task path, the Translate view
(text + file translation), the shared language/window contracts, and the topic docs
+ tests that record them.

**Method:** four parallel adversarial review passes (sidecar service, doc-task path,
renderer, docs/tests drift), followed by manual verification of every High finding and
the load-bearing Mediums against the code. Findings the wave's own reviews already
accepted as residuals (the ~1 ms adopt seed↔subscribe race, the systemic
lock-handler `isUnlocked` window, `snapshot.busy` during the picker await) are **not**
re-reported.

**Status:** working paper (audit report). Per the CLAUDE.md doc lifecycle rule, once its
findings are fixed or explicitly declined, fold the outcome into the relevant design
records and delete this file.

---

## Verdict

The feature is in good shape at the level the wave's per-phase reviews targeted: the
window math is sound (the fit property holds at every tested context), validation has a
single server-side choke point, logging/audit is content-free everywhere it was checked,
i18n is in parity, the docs match the code with one real exception, and no stale
references to the deleted plan file remain.

The gaps that remain cluster in two places the per-phase reviews structurally missed:

1. **Cross-cutting lifecycle seams** (quit vs lock vs the renderer gate) — each phase
   wired its own teardown correctly, but the *composition* leaks: quit does not cancel a
   running translation doc-task, lock does not flush the doc-task queue, and the
   renderer's lock purge turns out to be unreachable.
2. **"Successful-looking" failure shapes** — several paths accept partial or truncated
   output as success (SSE stream ending early, limit-stop truncation, an empty window in
   the view job, abort between token deliveries).

No finding is data-destroying; the worst cases are plaintext lingering longer than the
security model promises, silently truncated translations, and stuck-busy UI states.

---

## High findings

### H1 — Quit never cancels a running translation doc-task
[`shutdown.ts:54-61`](../apps/desktop/src/main/shutdown.ts#L54-L61) *(verified)*

`performShutdown` aborts the deep-index build and the Translate-view job
(`translateJobs.stop()`), but never calls `ctx.docTasks.cancelDocTask()` — asymmetric
with the lock path ([`registerWorkspaceIpc.ts:236`](../apps/desktop/src/main/ipc/registerWorkspaceIpc.ts#L236)),
which cancels precisely because a left-running translation is dangerous.

**Failure scenario:** quit mid-translation after ≥1 window succeeded. `translator.stop()`
kills the in-flight window; the retry hits the permanent `stopped` latch, so every
remaining window fails *fast* → `failedWindows < windows.length` → the handler proceeds
to `materializeDocument` concurrently with the awaited sidecar stops. It writes the
half-translated document — including untranslated source text under failed-window
notices — as a plaintext `<jobId>.parse.md` transient while the vault is locking, races
`processDocument` against the DB close, and if Electron exits between the write and the
`finally` shred, the plaintext transient rests on the drive until the next-launch sweep.

**Fix shape:** mirror the lock path — `ctx.docTasks?.cancelDocTask()` in
`performShutdown` before the sidecar stops (and ideally await the task's settle like the
chat streams' R1 treatment).

### H2 — Lock cancels only the active doc task; a queued translation runs during the lock window
[`registerWorkspaceIpc.ts:230-236`](../apps/desktop/src/main/ipc/registerWorkspaceIpc.ts#L230-L236),
[`manager.ts:392-406`](../apps/desktop/src/main/services/doctasks/manager.ts#L392-L406) *(verified)*

`cancelDocTask()` (no jobId) cancels the running task only; when it settles, the
manager's `pump()` immediately dequeues the next queued task. The comment's safety claim
("Still-queued tasks fail friendly at dequeue — `getDb()` throws while locked") is false
during the multi-second window before `ctx.workspace.lock()` runs: the DB is still open
while the handler awaits the `Promise.allSettled` sidecar suspends.

**Failure scenario:** translation A running, translation B queued; "Lock now". A is
cancelled → pump starts B → `getTranslator()` non-null, `getDb()` succeeds →
`extractSegmentTexts` decrypts the stored copy to a `.parse` transient *during the
lock*. Then `translateWithRetry` calls `translate()`: attempt 1 may hit the
`tearingDown` latch, but that latch clears in `teardown()`'s `finally`
([`runtime.ts:375`](../apps/desktop/src/main/services/translation/runtime.ts#L375)), so
attempt 2 (no backoff) lazily cold-starts a fresh ~10 GB sidecar that outlives the lock,
decoding document plaintext until the 120 s idle teardown — the exact hazard the TG-3
comments identify for the *running* task, unhandled for *queued* ones.

**Fix shape:** on lock, cancel/flush the whole queue (or add a manager-level suspend
latch consulted by `pump()`), not just the active task.

### H3 — The renderer's lock purge of both translation stores is unreachable (dead code)
[`TranslateScreen.tsx:148-153`](../apps/desktop/src/renderer/screens/TranslateScreen.tsx#L148-L153),
[`App.tsx:157-164, 183-195`](../apps/desktop/src/renderer/App.tsx#L157-L164) *(verified)*

`clearTranslateSession()` / `clearFileTranslate()` are called only from a
TranslateScreen effect gated on `locked` — but `locked` can only become true via a
mount/focus `getAppStatus` re-check *while the screen is mounted*, and the moment the
workspace locks, `App.tsx` swaps the entire shell for `WorkspaceGate`, unmounting the
screen. Screens render one-at-a-time, so if the user locks from Settings the screen is
not even mounted. Grep confirms no other caller of either purge function. The stores are
module-level by design, so they survive the unmount.

**Consequences:**
- Source text, streamed translation, and the file result's materialized preview stay in
  renderer memory for the whole locked period — contradicting the stated privacy-parity
  design ([`translateSession.ts:21-23`](../apps/desktop/src/renderer/lib/translateSession.ts#L21-L23))
  and the security-model.md "dropped on lock" claim.
- A mid-stream text session returns after unlock permanently `translating: true`/busy
  (main's `jobs.stop()` emits no `trError`; `adoptActiveJob` early-returns because
  `activeJobId` is still set) — only a manual Stop recovers.
- A mid-flight file session's module-level `setInterval` keeps firing `getDocTask` into
  the locked backend until the first throw lands it in `failed`, greeting the user with
  a stale "locked" banner after unlock.

**Systemic note:** `ImagesScreen.tsx:141` shares the identical dead pattern.

**Fix shape:** purge from a place that survives the gate swap — e.g. in `App.lockNow()`
next to `setWorkspace(next)`, or a lock event/subscription the module stores consume
directly.

### H4 — `pollInFlight` latch is shared across generations and force-released by superseded callbacks
[`fileTranslateSession.ts:109-115, 244-268, 299-328`](../apps/desktop/src/renderer/lib/fileTranslateSession.ts#L109-L115) *(verified)*

The reentrancy latch is a single module-level flag: `stopPolling()` force-resets it
while a superseded callback's IPC round-trip is still in flight, and that old callback's
`finally { pollInFlight = false }` runs even on the stale-generation early-return paths
— releasing the latch *owned by the new generation's in-flight tick*.

**Failure scenario:** a poll round-trip stalls (main busy with sidecar inference) → user
presses Stop → immediately drops another file → new poll tick A goes in flight → the old
callback resolves and its `finally` clears the latch → tick B fires concurrently → both
observe `status.done` → double `startTranslationTask` → the second `startDocTask` is
refused (task now active) → `failWith` kills the timer the first call just installed and
shows "failed", while the real backend task runs on as an unwatched zombie holding the
one-at-a-time lane and silently materializing a document. This re-opens exactly the
double-fire class the TG-5 review's C1 fix was for.

**Fix shape:** make the latch local to each `setInterval` closure (per-timer), and stop
resetting it in `stopPolling()`.

---

## Medium findings

### M1 — A sidecar crash mid-session leaves a dead server handle; retries fail until 120 s of quiet
[`runtime.ts:219-267`](../apps/desktop/src/main/services/translation/runtime.ts#L219-L267) *(verified — no `onUnexpectedExit` anywhere in `services/translation/`)*

`TranslationRuntime` never observes the child dying on its own and never clears
`this.server`, so after a crash `ensureStarted` keeps returning the dead `LlamaServer`
and every `translate()` fails with a connection error. Recovery is only the idle
teardown — armed 120 s after the *last* settle, so a user retrying (or a doc-task
walking its remaining windows) keeps the outage alive as long as attempts arrive less
than 120 s apart. Vision avoids this by rebuilding its runtime per analyze; this hybrid
inherited the reranker's latches but not a crash path.
**Fix shape:** wire an unexpected-exit callback to clear `this.server`, or probe
liveness in `ensureStarted`.

### M2 — An SSE stream that ends without the terminal `stop:true` frame is accepted as a complete translation
[`completion.ts:97-121`](../apps/desktop/src/main/services/translation/completion.ts#L97-L121) *(verified)*

`readCompletionSSE` treats reader `done` without ever seeing a final frame as normal
termination; `translate()` resolves the accumulated partial as success. A server-side
close mid-decode therefore emits `trDone` with truncated text in the view, and the
doc-task's `translateWithRetry` accepts any non-empty output and **materializes a
silently truncated document** — against the module's own "never a silent gap" invariant.
**Fix shape:** a `sawFinal` check that converts an early stream end into a retryable
error.

### M3 — Mid-stream errors emitted as `error:`-field SSE events would be silently swallowed
[`completion.ts:55-56`](../apps/desktop/src/main/services/translation/completion.ts#L55-L56) *(code shape verified; upstream behavior needs pin verification)*

`parseCompletionLine` only recognizes `data:` lines; the handled error shape is
`data: {"error":{…}}`. Upstream llama.cpp `server.cpp` can emit mid-stream failures as
an `error: {…}` SSE *field* line — if the pinned b9849 does, the error parses as
"not data:" → dropped, the stream ends without a terminal frame, and M2 converts a hard
server error into silently truncated success. **Fix shape:** handle both field shapes
defensively (cheap either way); verify against the pin in the next smoke run.

### M4 — Gemma control-token forgery via source text weakens the D2 "translated, never obeyed" guarantee
[`prompt.ts:96`](../apps/desktop/src/main/services/translation/prompt.ts#L96) *(verified — no stripping anywhere in the path)*

The source text is interpolated raw into the `/completion` prompt, and llama-server
tokenizes string prompts with special-token parsing enabled — so a literal
`<end_of_turn>` / `<start_of_turn>user …` sequence inside a pasted text or imported
document becomes *real* control tokens: the document can close the user turn and open an
attacker-authored one. The adversarial smoke only asserts plain-text imperatives are
translated — it never covers special-token forgery. Impact is bounded (offline app, the
output is still just a generated document), but D2 is a stated product guarantee.
**Fix shape:** strip or normalize the Gemma turn markers from `text` in
`buildTranslationPrompt` (one line), and add a smoke/unit case.

### M5 — `teardown()` is not single-flighted: `stop()` racing an in-flight `suspend()` resolves before the child is dead
[`runtime.ts:339-377`](../apps/desktop/src/main/services/translation/runtime.ts#L339-L377) *(verified)*

`teardown()` awaits `starting` and `idleTeardownPromise`, but a *concurrent teardown's*
`server.stop()` is untracked: suspend A nulls `this.server` and awaits the kill
(SIGTERM → 2 s grace → SIGKILL); a quit `stop()` arriving in that window sees
`server === null` and resolves immediately — `performShutdown` can exit with the SIGKILL
escalation still pending (possible orphaned child on POSIX). Overlapping suspends
likewise let the second's `finally` clear `tearingDown` while the first is still
killing, so a racing `translate()` passes the latch and cold-starts a fresh sidecar
during the vault re-encrypt. **Fix shape:** hold a `teardownPromise` and have concurrent
callers join it (the `idleTeardownPromise` pattern, applied to `teardown` itself).

### M6 — Output-limit truncation is undetectable: a window stopped at `n_predict`/context fill counts as clean
[`completion.ts:24-29`](../apps/desktop/src/main/services/translation/completion.ts#L24-L29),
[`handlers/translation.ts:49-61`](../apps/desktop/src/main/services/doctasks/handlers/translation.ts#L49-L61)

The final frame's stop reason is surfaced only as `stoppingWord` via `onFinal`, and
neither consumer passes `onFinal`; any non-empty reply counts as success. A greedy-decode
repetition loop (a classic MT pathology at temperature 0) that runs to the full
~2,070-token window cap gets stitched mid-sentence into the persisted document silently.
The acknowledged token-dense edge (sustained ~2.8 tok/word input) clips the same way.
**Fix shape:** treat a limit-stop (no `<end_of_turn>`/eos) as a failed window and route
it through the existing retry-then-mark path.

### M7 — The Translate-view job silently drops a window that returns empty
[`jobs.ts:136-161`](../apps/desktop/src/main/services/translation/jobs.ts#L136-L161)

The doc-task's retry-then-mark policy lives only in the doc-task handler; the view loop
accepts whatever each `translate()` resolves. An empty window contributes nothing — a
12-window paste with one transiently empty window completes "done" with a silently
missing paragraph. Only a *fully* empty final text fails (`'empty'`).

### M8 — `guardStart` is not re-checked after the picker await; a streaming text job can be orphaned
[`fileTranslateSession.ts:186-215`](../apps/desktop/src/renderer/lib/fileTranslateSession.ts#L186-L215),
[`translateSession.ts:207-212`](../apps/desktop/src/renderer/lib/translateSession.ts#L207-L212)

`guardStart()` runs only before `await pickDocuments`; if a text translation starts
while the dialog is open (requires a non-modal dialog: no focused window, or WM-dependent
Linux modality), `runImport` calls `clearTranslateSession()` — which is built for LOCK
and drops listeners/state **without cancelling the main-side job**. The orphaned job
keeps decoding invisibly, holds the one-at-a-time lane (next Translate gets a baffling
`busy`), and a later remount re-adopts it into a both-sessions-active state. This is a
distinct, unaccepted *consequence* of the accepted "busy not set during the picker
await" residual. **Fix shape:** re-run the guard (or `stopActive()`-cancel) after the
await.

---

## Low findings

| # | Where | Defect |
|---|-------|--------|
| L1 | [`completion.ts:99`](../apps/desktop/src/main/services/translation/completion.ts#L99) | An abort landing between token deliveries makes `translate()` resolve partial text as *success*, violating the `Translator` contract ("resolves with the full text"). Both current consumers happen to re-check the signal, so no user-visible bug today — a future consumer trips it. |
| L2 | [`jobs.ts:62-68, 230-242`](../apps/desktop/src/main/services/translation/jobs.ts#L62-L68) | The `TranslateJobService.tearingDown` latch is provably dead code (`stop()` has no `await`; the flag is set and cleared within one synchronous block). The comment claims a defense that does not exist. |
| L3 | [`registerTranslateIpc.ts:34-45`](../apps/desktop/src/main/ipc/registerTranslateIpc.ts#L34-L45) | Stream events bind permanently to the starting `webContents`; if that window is destroyed (multi-window), events drop silently, the job decodes for up to 45 min holding the lane, and a second window adopting via `getActive` sees a frozen snapshot. No auto-cancel on sender destroy. |
| L4 | [`completion.ts:72-75`](../apps/desktop/src/main/services/translation/completion.ts#L72-L75) | The parse catch is commented "partial frames", but the `\n`-splitter only feeds complete lines — the only thing it can swallow is a genuinely garbled frame, losing its delta silently. |
| L5 | [`translateSession.ts:195-201`](../apps/desktop/src/renderer/lib/translateSession.ts#L195-L201) | `stopActive()` early-returns while `activeJobId` is null, but Stop is already visible during the `translateStart` round-trip — a click in that window is silently swallowed (recoverable by pressing Stop again). |
| L6 | [`translateSession.ts:151, 173`](../apps/desktop/src/renderer/lib/translateSession.ts#L151) | The busy guard checks only `activeJobId` (asymmetric with `guardStart`), and `job.error` is dereferenced outside the try — a malformed bridge resolve leaves the store stuck `translating` with a dead Stop until reload (`onTranslate`'s `.then` has no `.catch`). |
| L7 | [`TranslateScreen.tsx:204`](../apps/desktop/src/renderer/screens/TranslateScreen.tsx#L204) | `onCopy` chains `?.then?.()` with no `.catch` — a rejected `copyToClipboard` IPC becomes an unhandled rejection (`onExport` right below wraps correctly). |
| L8 | [`TranslateDropZone.tsx:26-50`](../apps/desktop/src/renderer/translate/TranslateDropZone.tsx#L26-L50) | While busy, `onDragOver` still `preventDefault()`s (OS shows the copy cursor) but `onDrop` silently discards — "disabled" is communicated only via `aria-disabled`. |
| L9 | [`doctasks/translation.ts:94-97`](../apps/desktop/src/main/services/doctasks/translation.ts#L94-L97) | `translationUsableTokens` clamps `contextTokens` **up** to 1024 — if a future manifest ships a smaller real context, every window overflows it. Wrong backstop direction (theoretical today; manifest pins 4096). |
| L10 | [`ingestion/chunker.ts:74-104`](../apps/desktop/src/main/services/ingestion/chunker.ts#L74-L104) | `approxTokenCount` under-charges astral-plane/emoji glued runs (~4 UTF-16 units/token vs real Gemma ~1-2 tokens/emoji), so a pathological window can exceed the input estimate → server-side context error → failed-window notice. Degrades honestly, but "can only over-chunk, never overflow" is not absolute. |
| L11 | [`manager.ts:93, 336-344`](../apps/desktop/src/main/services/doctasks/manager.ts#L93) | `DocTaskManager.tasks` is never evicted (unbounded small growth per session), and the expired-id fallback hardcodes `kind: 'summary'` even for a translation poller. |
| L12 | [`doctasks/translation.ts:151-161`](../apps/desktop/src/main/services/doctasks/translation.ts#L151-L161) | `failedWindowNotice` + `translationAttributionLine` are hardcoded English and *persisted into the generated document* — a German-workspace user gets an English warning banner inside their translated document (all other task copy goes through `tMain`). |

---

## Documentation drift

| # | Severity | Finding |
|---|----------|---------|
| D1 | Medium | [`packaging.md:417`](packaging.md) — the `translategemma-smoke` row claims the smoke "keeps numbers/dates/codes **verbatim**". The test asserts only *stable identifiers* (invoice number, model code) verbatim; numbers/dates are deliberately **localized** ([`translategemma-smoke.test.ts:278-288`](../apps/desktop/tests/manual/translategemma-smoke.test.ts)). known-limitations.md and model-benchmarks.md agree with the code; packaging.md is the outlier. |
| D2 | Minor | [`translategemma-smoke.test.ts:46`](../apps/desktop/tests/manual/translategemma-smoke.test.ts#L46) — the file's own header leg list says "verbatim numbers/dates/codes preserved", contradicted by its body (the likely source of D1's wording). |
| D3 | Minor | [`doctasks/translation.ts:52`](../apps/desktop/src/main/services/doctasks/translation.ts#L52) — `TRANSLATION_PROMPT_RESERVE_TOKENS` comment still says "until TG-6 re-measures"; TG-6 shipped and kept 300. Reword to past tense. |
| D4 | Info | [`security-model.md:425-426`](security-model.md) says the view-job service logs "`{jobId, source, target}` — never the text"; [`jobs.ts:181`](../apps/desktop/src/main/services/translation/jobs.ts#L181) also logs `error: String(err)` on failure (content-free in practice — incomplete enumeration, not a privacy drift). |
| D5 | Minor | Three manual-test comments still cite the retired `HILBERTRAUM_TRANSLATION_SMOKE` env shape (test deleted at TG-3): `categorizer-smoke.test.ts:30`, `compare-smoke.test.ts:40`, `whisper-smoke.test.ts:16`. Should cite `HILBERTRAUM_TRANSLATEGEMMA_SMOKE`. |

**Verified consistent (no drift):** planner constants (2.5/3.0/1800, ~690-word window,
`windowMaxTokens` ≈ 2,071 recomputed from code — matches architecture.md and
model-benchmarks.md §11 exactly); sidecar args + timeouts (45 min request, 120 s idle);
manifest (17 GB min-RAM, ctx 4096, license `pending`, sha256/size); the 10-language set;
the architecture.md §-anchor legend + D1–D10 table (every in-code `plan §N`/`DN`/`ON`/`VN`
citation resolves); user-guide/design-guidelines "7 primary + 1 utility" = the nav code;
drive-layout dirs; CHANGELOG entry present. **No stale references to the deleted plan
file** anywhere outside dated history.

---

## Test-coverage gaps

Ordered by the findings they would have caught:

1. **Lifecycle seams (H1–H3):** no quit-path test against a *running* translation
   doc-task; no lock-path test with a running + queued translation pair; no test that the
   renderer lock purge actually fires in the real App flow (or of post-unlock store
   residue / the stuck-`translating` re-adopt).
2. **fileTranslateSession error paths (H4, M8):** nothing exercises a slow poll
   round-trip / the latch, Stop while `state === 'translating'`, `getImportJob`/
   `getDocTask` rejecting, a doc-task ending `failed`/`cancelled`, `previewDocument`
   throwing, `completed === 0`, or a text-translate-during-picker interleave.
3. **SSE reader (M2/M3):** `readCompletionSSE` has no unit test; the runtime tests feed
   the whole SSE as one chunk, so partial-frame-across-chunks, CRLF, no-trailing-newline
   flush, stream-end-without-final-frame, and `error:`-field events are all unexercised.
4. **Stop-reason handling (M6):** no truncation/limit-stop test; nothing pins that a
   per-request `TimeoutError` is treated as a failed window rather than a cancel (the
   semantics currently hang on the abort reason's *name*).
5. **View-job window failures (M7):** no partial-empty-window case.
6. **Misc:** the between-windows cancel pre-flight guard in the doc-task handler;
   `translate-ipc` never exercises `runtimeFailed`/`empty`; source text containing
   `<end_of_turn>` (M4); concurrent `stop()`+`suspend()` (M5); TranslateDropZone has no
   direct tests (busy-disabled drop, keyboard activation, non-file drag).

---

## Improvement opportunities (non-bugs)

- **Paste-size cap:** a multi-MB paste in the view plans hundreds of windows at
  ~3–4 tok/s CPU and holds the lane for hours; a friendly `badRequest` cap would be
  kinder than relying on Stop.
- **Double-residency on idle-teardown race:** a `translate()` arriving during an
  in-flight soft idle teardown cold-starts a second ~10 GB child while the first is
  still exiting; awaiting `idleTeardownPromise` before the cold start avoids the spike.
- **Provenance lacks the language pair:** `GeneratedProvenance` for translations records
  no `sourceLang`/`targetLang` (legacy `TranslationOrigin` at least had `targetLang`);
  only the mutable title carries it — a rename destroys the record.
- **Doc-task dedup:** double-clicking Translate enqueues two identical multi-minute jobs
  producing two output documents (`hasPendingKind` exists but is only used for
  `categorize`).
- **Cancel during re-parse:** `extractSegmentTexts` takes no abort signal; a cancel
  during a long encrypted-PDF re-parse isn't honored until the first window's pre-flight.
- **Mid-segment split artifact:** the doc-task path splits an over-budget segment
  mid-sentence and `join('\n\n')` inserts a spurious paragraph break — the exact artifact
  the view path documents and avoids for pastes.
- **Factory dead parameter:** `resolveSidecarSelection`'s `makeReal` generic is unused by
  the helper for the translator (the factory passes `makeTranslator` in *and* calls it
  itself) — drop the param to prevent drift.
- **Drop zone polish:** `onDragLeave` flickers when the pointer enters child elements
  (use a `relatedTarget`/`contains` check); non-file drags light up the affordance
  (gate on `dataTransfer.types.includes('Files')`); duplicate tab stops (zone
  `role="button"` + inner button).
- **A11y:** the document pane has no live region — importing/progress/done transitions
  are never announced (the text pane has `StreamAnnouncer`); `renderFileProgress` could
  be `role="status"`.
- **Partial-output honesty:** after cancel/`acknowledgeError()`, partial output renders
  through the plain-text "live" branch indefinitely with no "partial" indication; and a
  completed text result hidden behind a file-failure banner gives no hint it still
  exists.

---

## What held up under scrutiny (verified clean)

- **Logging/audit hygiene** — checked across the sidecar, jobs service, doc-task handler,
  and IPC: ids, language pairs, HTTP statuses, and `String(err)` only; no source or
  translated text reaches any log or audit event.
- **Validation** — the 10-code set + `source ≠ target` enforced at the single server-side
  choke point (manager), re-guarded in the handler, `requireUnlocked` on the IPC;
  enqueue *and* dequeue both re-check `getTranslator()`; legacy `TranslationOrigin`
  parsing round-trips.
- **Window math** — the fit property (input + output ≤ usable ctx) is mathematically
  sound at every tested context (690 × 2.5 = 1,725 + 2,071 = 3,796 = 4096 − 300); the
  1800 clamp binds correctly on larger contexts.
- **Abort plumbing (happy path)** — user cancel propagates end-to-end (controller →
  combined signal → fetch abort → slot release), with no listener accumulation across
  repeated jobs; the idle-teardown interlock's arm/refuse guards are correct.
- **jobs.ts state machine** — double-done prevented, late tokens after cancel are no-ops,
  the job map is bounded, `trDone` carries the full text.
- **i18n** — every `translate.*` key used exists in both en and de; parity is
  compile- and test-enforced.
- **Docs** — accurate against the code except D1–D5 above; the §-anchor legend fully
  covers the in-code citations; no dangling references to the deleted plan.

---

## Suggested priorities

1. **H1 + H2** (main-process lifecycle): small, localized fixes in `shutdown.ts` and the
   lock handler/manager; they close real plaintext-exposure windows the security model
   claims are closed.
2. **H3** (renderer lock purge): move the purge to `App.lockNow()` or a lock event; fix
   ImagesScreen's copy of the pattern in the same pass.
3. **H4 + M8** (fileTranslateSession): per-timer latch + post-picker guard re-check, with
   the missing error-path tests from gap #2.
4. **M2 + M3 + M6** (one `completion.ts`/handler pass): `sawFinal`, `error:`-field
   handling, limit-stop detection → retry path — together they eliminate the
   silent-truncation class.
5. **M4** (control-marker stripping): one line + a test; restores the D2 guarantee.
6. **M1 + M5** (runtime crash path + single-flight teardown) and the doc fixes D1–D5.
