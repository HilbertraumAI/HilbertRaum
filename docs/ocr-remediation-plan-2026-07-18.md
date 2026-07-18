# OCR remediation plan — wave "OCR-R" (from ocr-audit-2026-07-18)

> **Working paper** (implementation plan, deliberately uncommitted until the wave opens).
> Companion to `docs/ocr-audit-2026-07-18.md` — finding IDs (`FE-n`/`BE-n`/`DOC-n`) refer to it.
> Per the doc-lifecycle rule this file exists only while the wave is open: at close-out (P6)
> its decisions fold into an `architecture.md` remediation-ledger section and both working
> papers are deleted. Cite as `OCR-R P<n>` in commits.

**Branching (owner-confirmed audit-wave convention):** stacked branches
`fix/ocr-r1-initiation` → `fix/ocr-r2-translate-scan` → … each cut from the previous phase's
branch; one PR per phase with green CI (`ci-success` required — the repo is public, never
push `master`). Wave-open (P0) commits the two working papers so the plan is the reviewable
source of truth while work is in flight.

---

## §0 Ground rules — how this wave avoids introducing new issues

1. **RED→GREEN teeth, per repo idiom.** Every behavioral fix lands with a test that was
   *observed failing on the pre-fix tree* (noted in the phase's BUILD_STATE entry as
   "watched fail pre-fix"). Docs/comment-only changes are exempt but must leave the suite
   byte-green (count unchanged).
2. **Per-phase ritual (CLAUDE.md, mandatory):** `npm test` green + `npm run typecheck` +
   `npm run build` + affected `docs/` updated + `BUILD_STATE.md` entry + commit citing
   `OCR-R P<n>` and the finding IDs. A phase is not done until docs + BUILD_STATE are updated.
3. **Minimal diffs, additive shapes.** No drive-by refactors inside fix commits. Any shared
   type change must be additive-optional (absent-field-tolerant readers), recorded in
   `docs/data-contracts.md`. No schema migrations are needed anywhere in this wave.
4. **Blast-radius review before merge.** Each phase below names the *change's* blast radius
   (what the diff can break, not just what the bug broke) and the regression guards that
   must stay green. If an edit escapes the named radius (unexpected test reddens, an
   unrelated surface changes), stop and re-scope — don't absorb it silently.
5. **i18n discipline:** every new string lands EN+DE in the same commit (parity is
   test-enforced); persisted-canonical strings go through the display map per D-L4 only if
   they are persisted (none planned here — all new strings are render-time).
6. **Concurrent-session hygiene:** stage explicit files only (never `git add -A`); the two
   working papers ride only on the P0 wave-open commit.
7. **Scope freeze:** new findings discovered mid-wave get recorded in the ledger draft and
   filed, not fixed in-line, unless they block the phase's DoD.
8. **Independent verification before close (P6):** a fresh-context review pass over the
   wave's full diff verifies each finding's fix against the audit's mechanism description —
   the repo's established audit-verifies-remediation pattern.

---

## §1 Phase map

| Phase | Branch | Scope (finding IDs) | Size | Risk of the change | Gate to proceed |
|---|---|---|---|---|---|
| P0 | `fix/ocr-r0-wave-open` | Commit audit + plan, BUILD_STATE wave-open entry | S | None (docs-only) | CI green |
| P1 | `fix/ocr-r1-initiation` | **FE-1, FE-2, BE-1, FE-4, FE-5** (the interlock) | M–L | Medium — DocRow render + task admission | All new tests RED→GREEN; manual dev-run smoke |
| P2 | `fix/ocr-r2-translate-scan` | **FE-3** | S | Low — one renderer session module | RED→GREEN |
| P3 | `fix/ocr-r3-docs-truth` | **DOC-1, DOC-2, DOC-3, DOC-4, DOC-5(docs half), BE-3, BE-4(comment), BE-9(docs half)** | S | None (docs/comments) | Suite count unchanged |
| P4 | `fix/ocr-r4-hardening` | **BE-5, BE-6, BE-7, BE-8, BE-9(code half)** | M | Low–Medium — engine/rasterizer internals | RED→GREEN per item |
| P5 | `fix/ocr-r5-csp` | **BE-2** + rasterizer test harness (audit test-gap #2) | M + manual probe | Medium — app-wide CSP | Packaged-build probe done; packaged OCR smoke |
| P6 | close-out on the chain tip | Ledger §, working-paper deletion, deferral registration, CHANGELOG | S | None | Independent diff verification pass clean |

Recommended order is as listed. P2 and P3 are independent of each other and may swap;
**DOC-1 (High) may be cherry-picked into P0 if P1 stalls** — it is one line and shouldn't
wait on code work. P5 is scheduled last because it carries the one manual dependency
(a packaged build) and the widest regression surface.

---

## §2 P1 — Restore OCR initiation safely (FE-1 + FE-2 + BE-1 + FE-4 + FE-5)

The audit's core interlock: FE-1/FE-2 reopen the only user paths into `startDocTask('ocr')`,
which makes BE-1's unguarded start reachable. **Within the phase, land BE-1 first** so the
guard exists before any UI can exercise the new paths.

### Step 1 — BE-1: mirror the one-way guard at task admission
- **Change.** Add `isDocumentProcessing?: (documentId: string) => boolean` to `DocTaskDeps`
  (`apps/desktop/src/main/services/doctasks/context.ts`) — same late-bound-closure pattern as
  the existing `getOcrEngine`/`beginDocumentWork` seams. In
  `manager.ts` `startDocTask`, for **every** kind (not just `ocr` — the guard is about
  overlapping ingestion, not OCR specifically), refuse when the predicate reports the target
  doc is mid-import/re-index, with a friendly localized error (new key
  `main.task.documentBusyIngesting`, EN+DE). Wire the predicate where the `processing` set
  lives (`registerDocsIpc.ts`) into the deps at composition/registration time.
- **Design decision (recommended):** predicate injection, not moving the `processing` set —
  zero churn to the existing import/reindex machinery and to the DB-3 reconcile-sweep logic
  that already reads the set. *Declined:* extracting `processing` into a shared service
  (bigger diff, touches the sweep, no added safety).
- **Blast radius of the change.** Task admission for all seven kinds. The predicate must be
  `false` when absent/unwired (old tests construct deps without it — optional field keeps
  them byte-green) and must never be `true` outside a live import/re-index (else legitimate
  starts get refused — the user-visible failure mode of an over-eager guard).
- **New tests (RED→GREEN):** unit — manager with `isDocumentProcessing: () => true` refuses
  `ocr` (and one non-ocr kind) with the new message; integration — gated slow re-index of an
  already-OCR'd PDF (the repo's fake-embedder gate pattern), `startDocTask('ocr')` during it
  refused, and succeeds after release. This closes audit test-gap #3.
- **Regression guards:** `ocr-task.test.ts`, `docs-ipc.test.ts`, doctasks suites (all green today).

### Step 2 — FE-1: a reachable "Make searchable (OCR)" control
- **Change.** In `DocRow.tsx`'s **failed branch** (`:276-301`), when `showOcr`, render a
  primary inline Button "Make searchable (OCR)" (reuse `docs.makeSearchable` +
  `docs.makeSearchableTitle`) ahead of Try again/Remove, disabled while `busy !== null` or
  `anyTaskActive` (mirror the overflow item's gating). Banner copy `docs.scan.ocrOffer`
  ("…below…") stays truthful once the button exists; re-read it and adjust EN+DE if the final
  placement makes "below" wrong.
- **Design decision (recommended):** inline button in the failed branch — smallest diff,
  matches the banner's promise, and keeps the §11.6 rule "failed rows have no overflow"
  intact (the right-click guard at `DocRow.tsx:162` and the pinned test
  `DocumentsScreen.test.tsx:296` stay valid). *Declined:* remodeling scan-detected as a
  non-failed sub-state — it would touch status consumers everywhere (smart views, counts,
  reconcile sweep, retry logic) for no user-visible gain; exactly the new-issue risk this
  plan is meant to avoid.
- **Blast radius of the change.** Rendering of **all** failed rows (the branch is shared with
  ordinary failures) — the button must be strictly `showOcr`-gated so non-scan failures are
  byte-identical; keyboard/focus order in the trailing cluster shifts for scan rows only.
- **New tests (RED→GREEN, closes audit test-gap #1/#3):** renderer — a `scanDetected` row
  shows the button; click → `startDocTask({kind:'ocr'})`; a non-scan failed row renders
  byte-identically to today (control); `ocrAvailable:false` shows `docs.scan.ocrMissing` and
  no button; busy row disables it.
- **Regression guards:** the full `DocumentsScreen`/`DocumentsScreenPolish` suites (123 green
  today), the failed-row-no-overflow pin at `:296` (must stay green — we are not adding an
  overflow), a11y pins in the polish suite.

### Step 3 — FE-2: the D33 explicit redo
- **Change.** In the healthy-row overflow, add "Read again (OCR)" (new keys
  `docs.makeSearchableAgain` EN+DE + title explaining redo-vs-Re-index) gated
  `d.ocr != null && ocrAvailable && !anyTaskActive`. The scan-row case is Step 2's button;
  this item is the indexed-doc redo the backend already admits (`manager.ts:306-312`).
- **Blast radius.** Overflow menu of indexed OCR'd PDFs only. Redo now *reachable* means the
  BE-1 race would be reachable too — which is why Step 1 precedes it.
- **New tests:** renderer — OCR'd indexed row offers the item, click starts the task; plain
  indexed row (no `ocr`) does not offer it. Integration already covers backend admission.

### Step 4 — FE-4 + FE-5: honest progress through the finishing step
- **Change.** In `DocRow.tsx`, when `rowTask.kind === 'ocr'` and
  `stepsDone >= stepsTotal - 1` (the re-ingest step), switch the busy label to a new key
  `docs.task.ocrFinishing` ("Finishing — making the text searchable…", EN+DE) instead of
  "Reading the scan… (n/n)". Cancel **stays enabled** (a legitimately cancellable pre-persist
  instant shares this renderer-visible state — verified against `handlers/ocr.ts:69-114`;
  disabling would remove a real cancel window). After a cancel click, render the button
  disabled with `docs.task.stopping` ("Stopping if possible…") — honest about the GAP-7
  duality, which DOC-2 (P3) documents user-side.
- **Design decision (recommended):** label-switch, not the Translate-style `stepsTotal − 1`
  subtraction — the count stays truthful to the design record's "progress = pages + the final
  re-ingest step", and the two surfaces' conventions get documented rather than silently
  diverging (P3 notes it). *Declined:* a new `DocTaskStatus.progress.phase` field — a shared-
  shape change (data-contracts churn) for a distinction the step counter already carries.
- **Blast radius.** OCR busy rows only (`rowTask.kind === 'ocr'` guard keeps summary/translate/
  compare rows byte-identical). The ~ms ambiguity (pre-persist instant shows "Finishing")
  is accepted and noted in the design record.
- **New tests:** renderer — task status at `stepsDone = pages` renders the finishing label +
  enabled Cancel; cancel click flips to disabled "Stopping…"; mid-pages status still renders
  "Reading the scan… (k/n)".

### P1 docs + DoD
- **Docs:** `user-guide.md` §"Scanned PDFs" (the action is now a button on the row; redo item
  for OCR'd docs); `architecture.md` Phase-38 record — initiation surface, the admission
  guard, the finishing-label display contract (fold the DOC-1 correction here only if P3
  won't land promptly; otherwise leave it to P3 to avoid a same-paragraph collision).
- **DoD gate:** all new tests observed RED pre-fix, now green; full suite + typecheck + build
  green; **manual dev-run smoke** (`npm run dev`, import a scanned PDF, run OCR end-to-end,
  cancel once mid-pages and once during finishing) — with real OCR assets if present on the
  dev drive, else the fake-engine path plus the manual smoke deferred to P5's packaged check;
  BUILD_STATE entry.

---

## §3 P2 — Translate scan handoff (FE-3)

- **Change.** In `fileTranslateSession.ts` (`:303-309`), on `done && completed === 0`, fetch
  the failed document's `errorMessage` (`getDocument`/list IPC — read-only, no new IPC
  surface) and: scan notice → new failure code `scanned` rendering
  `translate.file.err.scanned` (EN+DE: "This PDF looks like a scan with no readable text.
  Make it searchable first in Documents — 'Make searchable (OCR)' — then translate it.");
  any other ingest failure → surface the localized `error_message` via `localizeServerCopy`
  with a generic import-failed frame; keep `unsupported` for the genuinely-unsupported
  pre-import path only.
- **Blast radius of the change.** Every Translate import-failure path (scan, corrupt,
  encrypted) — the *genuinely unsupported extension* path must remain byte-identical, and the
  session-state machine (`fail()` codes) gains one code; check exhaustive switches/maps over
  the code union so no `default` silently swallows it.
- **New tests (RED→GREEN):** scan-detected import → scanned copy + no "try a PDF" text;
  corrupt-PDF import → localized real message; unsupported extension → unchanged copy
  (control). Closes the FE-3 slice of audit test-gap #1.
- **Regression guards:** `TranslateScreen`/`DocumentTranslate` suites (green today).
- **Docs:** `user-guide.md` Translate section (scanned PDFs: make searchable first);
  `known-limitations.md` Document-translation bullet gains the pointer. BUILD_STATE entry.

---

## §4 P3 — Docs & comments truth batch (DOC-1..5, BE-3, BE-4, BE-9 docs-half)

All docs/comment-only; suite must end byte-green (count unchanged). One PR.

| Item | Edit |
|---|---|
| **DOC-1 (High)** | `architecture.md:1567` — replace "Cancel persists nothing." with the two-part GAP-7 contract (pre-persist cancel persists nothing; a cancel during the final re-ingest is deliberately ignored and completes `'done'`). |
| **DOC-2** | `known-limitations.md` OCR section — new bullet beside the mid-page one: a cancel after recognition (during the final re-index step) can no longer stop the task; the document completes searchable, and the row shows "Stopping if possible…" (P1's UI). Soften `user-guide.md`'s "You can always cancel" accordingly. |
| **DOC-3** | Same section — clause on the photo asymmetry: a photo's recognition is not persisted separately; re-index re-runs it (seconds), unlike a scanned PDF's stored pages. |
| **DOC-4** | Same section + `architecture.md` timeout paragraph — name the second ceiling: a fixed 60 s per-step **render** timeout (`RASTER_STEP_TIMEOUT_MS`, not env-tunable) besides the 2-min recognition ceiling (`HILBERTRAUM_OCR_PAGE_TIMEOUT_MS`). (If P4 adds an env override, write it as tunable there instead — coordinate.) |
| **DOC-5 (docs half)** | `troubleshooting.md` OCR remedy + `drive-layout.md` OCR section — one sentence each: restart the app after adding the OCR files; availability is resolved at startup. |
| **BE-3** | `handlers/ocr.ts:52-53` comment — reword to "recognitions serialize; the rasterizer keeps at most a 1-deep render look-ahead (ING-5)". |
| **BE-4 (comment)** | `doctasks/context.ts:54-59` — "fixed at startup; restart after installing assets" (drop "can appear mid-session"). The *behavioral* alternative is deliberately deferred — see §8 owner register. |
| **BE-9 (docs half)** | `security-model.md` — a "pinned parser libraries (pdfjs, tesseract.js): review upstream advisories each release; offline posture has no auto-update channel" line. |
| Consistency note | Record (architecture Phase-38 ¶) that Documents shows the +1 finishing step by label while Translate subtracts it — the deliberate difference P1 chose. |

**Blast radius:** none at runtime. Guards: `repo-hygiene.test.ts` (NUL-ban walks docs/),
BUILD_STATE size budget, link hygiene. **Docs cross-check:** re-grep the exact stale phrases
("Cancel persists nothing", "can appear mid-session") repo-wide to zero-hit after the edits.

---

## §5 P4 — Backend hardening batch (BE-5, BE-6, BE-7, BE-8, BE-9 code-half)

Independent small fixes; land as separate commits in one PR, each with its own RED→GREEN test.

- **BE-8 (smallest first).** `parsers/image.ts:49` → `engine.recognize(image, { signal: ctx?.signal })`.
  Test: gated fake engine observes the signal; cancelled import aborts the recognition.
  Radius: photo-import parse path only; existing ingestion tests guard.
- **BE-5.** (a) `ensureWorker()` throws when `this.stopped` (test: recognize queued after
  `stop()` rejects, no worker spawned — RED pre-fix). (b) Lock-list membership: **do not**
  add terminal `stop()` to the workspace-lock teardown — it would permanently kill OCR until
  relaunch (a new bug). Recommended: expose the existing REL-2 terminate-and-recreate
  machinery as a non-latching `suspend()` (terminates the warm worker; next recognition
  lazily respawns) and add *that* to the lock teardown list (`registerWorkspaceIpc.ts:280-298`),
  restoring the stated sidecar parity. Fix the `tesseract.ts:19` comment either way.
  Tests: suspend → worker gone → next recognize respawns and succeeds; lock teardown calls it.
  Radius: engine lifecycle + lock path; guards: `ocr.test.ts` REL suites, workspace-lock
  integration tests.
- **BE-6.** Clamp the page walk to `resolveIngestionLimits().pdfMaxPages`, enforced in the
  **pure pipeline** (`pipelinePages` gains a `maxPages` input — unit-testable without
  Electron), with the rasterizer resolving and logging the truncation
  (`onPageCount` reports the clamped count, so `stepsTotal`, progress and `ocr_json.pageCount`
  stay truthful). Test: declared 1M pages → clamped count, log line, pipeline walks the cap.
  Docs: known-limitations bullet (mirrors the parser's M-2 wording). Radius: page iteration
  only; guards: `ocr-pipeline.test.ts` invariants (look-ahead, R4) must stay green.
- **BE-7.** `renderer/ocr/main.ts` — `page.cleanup()` after each page's PNG encode;
  `rasterizer.ts` — subscribe `render-process-gone` and fail the run immediately (friendly
  `ocrFailed`) instead of burning 60 s per remaining step; the listener joins the existing
  `finally` cleanup. Automated teeth arrive with P5's harness (gone-event path); `cleanup()`
  itself is manual-smoke territory — registered in §8. Radius: hidden-window render loop +
  rasterizer error path; guards: slot/pipeline unit suites, P5 packaged smoke.
- **BE-9 (code half).** Derive the engine id from the installed tesseract.js version
  (`createRequire` → `tesseract.js/package.json`, the packaged-safe idiom already used for
  worker resolution) — byte-identical `'tesseract.js-7.0.0'` today. Test: id equals
  `` `tesseract.js-${version}` ``; update any pinned-string asserts (`ocr-meta-list` checks).
  Radius: `ocr_json.engineId` provenance for *future* runs only.

**Phase DoD:** each item RED→GREEN; full suite + typecheck + build; BUILD_STATE entry;
known-limitations/architecture touched as listed.

---

## §6 P5 — Packaged CSP truth (BE-2) + rasterizer harness (test-gap #2)

- **Step A — measure first (manual, owner-runnable; instructions land in the PR).** Build a
  packaged app (`npm run package:win` — manual/network-touching per R2). In BOTH windows
  (main; hidden OCR window via a temporary dev flag that opens it visibly or via
  `webContents.executeJavaScript`), record: the effective CSP (does the
  `onHeadersReceived` header attach to `file://`?) and whether `fetch('http://127.0.0.1:<closed-port>')`
  is CSP-blocked vs network-errored. **The fix is chosen by the outcome — do not pre-commit.**
- **Step B — single source of truth.** Whatever Step A shows, eliminate the dev/prod meta
  drift: generate the meta tags at build time from `buildCsp(isDev)`
  (`electron.vite.config.ts` HTML transform), so `ocr.html`/`index.html` carry the strict
  policy in prod and the localhost relaxation only in dev. Before landing, reconcile
  `buildCsp(false)` with what pdfjs needs in the OCR window (`worker-src 'self' blob:`,
  `img-src data: blob:`) — an over-tight intersection would break rasterization *only in
  packaged builds*, the exact place CI can't see (hence Step C + the packaged smoke gate).
- **Step C — rasterizer wiring harness.** Fake-Electron/jsdom harness (the
  `window-security.test.ts` pattern) for `rasterizePdfWithHiddenWindow`: window destroyed on
  success/error/timeout/abort, in-use latch, 60 s step timeout, sender-spoof rejection,
  listener removal, and P4's `render-process-gone` fast-fail. Plus a build-output test:
  built prod HTML contains no `localhost` in the CSP meta (guards the transform forever).
- **Blast radius of the change.** App-wide (both windows' CSP). Regression guards:
  `window-security.test.ts` pins (update alongside), the new build-output test, and the
  **gate**: packaged-build launch + the release-acceptance OCR smoke
  (`tests/manual/ocr-smoke.test.ts` flow) pass on Windows before merge; macOS/Linux packaged
  smoke registered as a deferral if no machine is at hand (§8).
- **Docs:** `security-model.md` rewritten to the *measured* mechanism (header vs meta on
  `file://`); `packaging.md` notes the build-time CSP generation.

---

## §7 P6 — Wave close-out (per doc-lifecycle rule)

1. **Independent verification pass (ground-rule 8):** fresh-context review of the whole
   chain's diff against each audit finding's mechanism — every ID Fixed/Deferred with
   evidence; any miss reopens its phase before merge of the chain.
2. **Durable record:** new `architecture.md` section "OCR audit (2026-07-18) — remediation
   ledger" — per-finding disposition table (fixed@phase+commit / deferred→where / watch),
   the P1 design decisions (inline-button over status remodel; label over count-subtraction;
   guard-predicate over set extraction; suspend over terminal stop), and a §-anchor legend so
   `ocr-audit 2026-07-18 <ID>` / `OCR-R P<n>` citations in commits/tests resolve forever.
3. **Delete both working papers** (`docs/ocr-audit-2026-07-18.md`, this file) — full text
   stays in the P0 commit's history; re-point any references to the ledger section.
4. **Register deferrals** (§8 table) in BUILD_STATE §5 / issues; CHANGELOG entry ("Scanned-PDF
   OCR is startable again from the Documents row; re-run supported; Translate explains
   scanned PDFs") — user-visible regression fix, it earns a line.
5. BUILD_STATE close-out entry; retention rule (entries → build-log at close). Suite +
   typecheck + build green; merge the stacked chain per the owner's audit-wave convention.

---

## §8 Owner decisions & registered deferrals

**Decisions this plan makes (revisit at P-boundary if the owner disagrees):**

| # | Decision | Alternative declined (why) |
|---|---|---|
| 1 | FE-1: inline button in the failed branch | Non-failed scan sub-state (status consumers everywhere — new-issue risk) |
| 2 | FE-4: finishing label; count keeps the +1 | Translate-style subtraction (silently divergent honesty conventions) |
| 3 | FE-5: Cancel stays enabled + "Stopping if possible…" | Hard-disable at final step (would kill a real pre-persist cancel window) |
| 4 | BE-1: guard applies to all task kinds | ocr-only guard (same race exists in principle for any future non-indexed-gated kind) |
| 5 | BE-5: `suspend()` for lock; `stop()` stays quit-only | Terminal stop in lock list (bricks OCR until relaunch — a new bug) |
| 6 | BE-6: clamp to `pdfMaxPages` | Recorded exemption (a cap asymmetry with no upside) |
| 7 | DOC-5: document restart now; defer mid-session refresh | Per-`getAppStatus` fs re-probe (4 s-interval disk scans on USB drives) |

**Deferrals to register at P6 (not in this wave):**

- Mid-session OCR-asset refresh (translator-#40 analogue or an explicit "Check again"
  affordance on the `ocrMissing` banner) — needs an owner UX call.
- BE-7 memory profile of a real 300+-page scan (manual smoke, real assets).
- macOS/Linux packaged CSP + OCR smoke (P5 verifies Windows).
- `renderer/ocr/main.ts` pdfjs-side automated tests (beyond the P5 harness's protocol level).
- Audit test-gap #5 leftovers: pin the `.parse-ocr.pdf` transient name to the crash-sweep
  pattern (cheap — may ride along in P4 if trivial).

---

## §9 Traceability — every audit item lands somewhere

| Audit item | Phase | Teeth (test) | Docs |
|---|---|---|---|
| FE-1 Critical | P1.2 | renderer initiation suite (RED pre-fix) | user-guide, arch record |
| FE-2 | P1.3 | redo-item renderer test | user-guide |
| BE-1 | P1.1 | manager unit + gated-reindex integration | arch record |
| FE-4 | P1.4 | finishing-label test | arch record note (P3) |
| FE-5 | P1.4 | stopping-state test | DOC-2 text (P3) |
| FE-3 | P2 | scan/corrupt/unsupported triple | user-guide, known-limitations |
| DOC-1 High | P3 | grep-to-zero stale phrase | architecture.md:1567 |
| DOC-2/3/4/5 | P3 | suite byte-green | known-lims, user-guide, troubleshooting, drive-layout |
| BE-3/BE-4 | P3 | — (comments) | in-code |
| BE-5 | P4 | respawn-after-stop + suspend tests | arch record |
| BE-6 | P4 | clamp unit test | known-limitations |
| BE-7 | P4 (+P5 harness) | gone-event fast-fail (P5) | known-limitations note |
| BE-8 | P4 | signal-abort test | — |
| BE-9 | P3 (docs) + P4 (code) | engineId-derivation test | security-model |
| BE-2 | P5 | build-output CSP test + packaged smoke | security-model, packaging |
| Test-gap #1 (initiation/display) | P1, P2 | as above | — |
| Test-gap #2 (rasterizer wiring) | P5.C | harness suite | — |
| Test-gap #3 (concurrency) | P1.1 | as above | — |
| Test-gap #4 (pdfjs page side) | deferred (§8) | — | — |
| Test-gap #5 (transient name, engineId) | P4 (+§8) | as above | — |

---

## §10 Rollback & mid-wave correction

Stacked chain: a defect found in phase N after later phases exist is fixed **on N's branch**
and the descendants rebase (small phases keep this cheap — the reason the wave is six small
phases, not two big ones). Every phase is independently revertable pre-merge; after the
close-out merge, reverts go finding-wise (each finding's fix is a coherent commit). If P5's
packaged smoke fails on the CSP change, ship P5 as Step A's *measurement + docs truth* only
(security-model correction) and re-plan Step B — the strict-meta change is the one edit in
this wave whose failure mode CI cannot catch.
