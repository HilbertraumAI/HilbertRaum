# Image Understanding (vision) — pre-merge multi-persona audit

_Branch `image-understanding` → `master`. READ-ONLY audit (findings only, no fixes). 2026-06-20.
Scope: the five-phase vision feature (V1 research gate → V2 backend → V3 Images screen → V4 real
runtime + idle teardown → V5 eval/docs/plan-fold). Every claim below was checked against the **code
and tests**, not against BUILD_STATE / the design record. The original plan was read from git
(`git show HEAD~1:docs/image-understanding-plan.md`)._

---

## Executive summary

**Safe to merge — no blocker, no CRITICAL, no active HIGH.** All §0 hard redlines hold on the real
path: the sidecar fetch is loopback-only (`127.0.0.1`), no image/prompt/answer byte ever reaches a
log line or audit row, the CSP is unchanged (`img-src 'self' data:`, **no** `blob:`), no temp file is
written, no native npm dependency is added, and the app launches + the suite is green with **zero**
vision models (`npm test` during this audit: 1965 passed / 30 skipped, exit 0). The RUNTIME-4 idle-teardown interlock — the net-new, race-prone code — is correct on a
full static walk of every interleaving.

**Two latent HIGHs** must be tracked before the *first real vision drive* ships (they do **not** block
this merge because **no `role:vision` manifest is committed** and the green-gate posture holds):
**DIST-1** — the in-app downloader + `fetch-models` scripts still fetch only the GGUF, never the
mmproj, so a vision model can never reach `installed` via the normal pipeline (it must be hand-placed);
**DIST-2** — `assertCommercialDrive`/`verify-models` verify only the GGUF, so a sold drive with a
missing/corrupt projector would pass the sell gate.

**The most important quality gaps** are in the **tests, not the implementation**: the security
content-leak sentinel is partly vacuous (an answer-leak on the success path would not be caught), and
the RUNTIME-4 race tests are `sleep`-ordered rather than deterministic (the `this.starting` guard
branches would not redden if removed). One real **doc** dishonesty: the user-guide + troubleshooting
say a second question "waits until the first finishes" when the code busy-**rejects** it.

---

## Remediation status (V6 — 2026-06-20)

**ALL findings RESOLVED.** Remediated on branch `image-understanding` (the "V6" remediation commit;
see BUILD_STATE V6 entry). Suite after remediation: **1984 passed / 30 skipped**, `typecheck` clean.

| ID | Status | Fix |
|----|--------|-----|
| **DIST-1** | ✅ RESOLVED | `assets.ts` `planModelDownloads` emits a second `ModelDownloadTask` for `mmproj.download` via the shared `planOneFile`; `fetch-models.{sh,ps1}` fetch the projector (block-scoped `mmproj:` parse + per-file `handle_file`/`Invoke-HandleFile`). Tests: `assets.test.ts` "plans BOTH the GGUF and the mmproj…" (+ "plans the mmproj even when the GGUF is present"). In-app `downloads.ts` stays GGUF-only (`tasks[0]`) by design — documented residual. |
| **DIST-2** | ✅ RESOLVED | `models.ts` exports `manifestFiles` (GGUF+mmproj); `drive.ts` `verifyDriveModels` folds to the first non-`verified` file, `buildChecksumsJson` emits one entry per file. Tests: `drive.test.ts` "vision two-file fold" + `commercial-drive.test.ts` "fails a vision drive whose … mmproj projector is MISSING". |
| **TEST-1** | ✅ RESOLVED | `vision-security.test.ts` — answer streamed then failure asserts the real `index.ts` catch logs ONLY `{jobId, error}` (exact keys, content-free); plus a success-path "answer exists but never logged" case. |
| **TEST-2** | ✅ RESOLVED | NET-NEW injectable `IdleClock` seam in `runtime.ts`; `vision-runtime.test.ts` deterministic block covers (b) mid-teardown cold-start, (c) `stop()` awaits `idleTeardownPromise`, (e) `unref`, (a) stale-fire inFlight guard. |
| **TEST-3** | ✅ RESOLVED | `vision-security.test.ts` "never invokes the OCR engine and writes no documents/ocr_json" (spies `createSelectedOcrEngine`; asserts an empty drive root). |
| **TEST-4** | ✅ RESOLVED | New jsdom `tests/unit/decode.test.ts` — client `unsupportedType` (null MIME) + over-dimension `tooLarge` + `decodeFailed`. |
| **SEC-1** | ✅ RESOLVED | `registerImagesIpc.ts` logs `{ ext, code }` (errno) instead of `String(err)` (path-bearing). |
| **DOC-1** | ✅ RESOLVED | `user-guide.md` + `troubleshooting.md` reworded — a second question is busy-REJECTED (declined, not queued). |
| **UX-NIT-1** | ✅ RESOLVED | Dead `images.answer.clear` key removed from `en.ts` + `de.ts`. |
| **DOC-2** | ✅ RESOLVED | `architecture.md` §9 legend gained a `plan §5.1–§5.6 → §5 / §4 state matrix` row. |

---

## Findings

Severity: CRITICAL / HIGH / MEDIUM / LOW / NIT. "Latent" = correct today, bites only a future vision
drive. Separated into **implementation/test bugs** and **doc inaccuracies**.

### Implementation / test bugs

| ID | Sev | Persona | Claim vs reality | Evidence | Remediation |
|----|-----|---------|------------------|----------|-------------|
| **DIST-1** | HIGH (latent) | Packaging | Plan §8.3 (DIST-1) requires the download side to fetch **two** files per vision modelId. As built, only the *verify* side knows about the mmproj; the *download* side fetches only the GGUF. A vision model could therefore never reach `installed` through the in-app downloader or `fetch-models` — `computeInstallState` would report `missing` forever. | `assets.ts:67-110` `planModelDownloads` emits one task per manifest from `weightPath`/`manifest.sha256`/`manifest.download`; `manifest.mmproj` is never read (`assets.ts:95-107`). `fetch-models.{sh,ps1}` have no mmproj concept (grep `vision|mmproj` → no match). Contrast the verify side, which is correct: `models.ts:335-337` (`manifestFiles` pushes mmproj). | Extend `planModelDownloads` to emit a second `ModelDownloadTask` (same `modelId`) from `manifest.mmproj.download → mmproj.local_path` verified against `mmproj.sha256`; teach `fetch-models.{sh,ps1}` the same. This is the "two jobs sharing one modelId" topology the plan picked but did not build. |
| **DIST-2** | HIGH (latent) | Packaging | Plan §16-V5 says "then `assertCommercialDrive` verifies GGUF + mmproj". As built it verifies only the GGUF; a sold drive with a missing/corrupt projector would pass the sell gate (`weightsVerified:true`) and ship a model that cannot start. | `commercial-drive.ts:330` delegates to `verifyDriveModels`, which resolves and hashes only `weightPath(...)` and `manifest.sha256` (`drive.ts:256,268`); `manifest.mmproj` is ignored. `buildChecksumsJson` has the same single-file blind spot (`drive.ts:320`). | Make `verifyDriveModels` + `buildChecksumsJson` iterate the same `manifestFiles` set `computeInstallState` uses (GGUF + mmproj). Close this **before** a `role:vision` manifest is committed. |
| **TEST-1** | MEDIUM | Test/QA | The §17 security sentinel is meant to catch a real content leak. As written its content-leak assertions are partly **vacuous**: an answer leaked on the **success** path would not be caught. | `vision-security.test.ts:154-155`: the success test reaches `done` and the production success path **logs nothing** (`index.ts` logs only in `catch`, `:138`), so `expect(allLog).not.toContain('ZZSENTINELZZ')` asserts a secret is absent from an essentially empty string. The failure test (`:161-193`) forces HTTP 500; the thrown message is `Vision request failed: HTTP 500` (`runtime.ts:205`) which structurally cannot carry the answer (it never arrived) — so the assertion passes by construction, not by catching a careful logger. (The loopback check `:150` and `audit not-called` `:158,192` **are** genuine; and the failure path *would* catch a regression that logged `req.question` in the catch, since the sentinel prompt is in `req`.) | Add a test that routes content through the **actual** log path and verifies absence: force the runtime to throw an error whose message *embeds* the answer, assert `log.warn` got only `{jobId, error}`; and assert `log.*` is **not** called with content on the success path. |
| **TEST-2** | MEDIUM | Test/QA | The RUNTIME-4 race tests claim to exercise the idle-teardown interleavings. They are `sleep`-ordered, not deterministic; several interleavings the design comments emphasize are never actually raced and would pass even with the `this.starting` guards removed. **(NB: the implementation itself is correct — see the runtime walk below; this is a test-strength gap, not a runtime bug.)** | `vision-runtime.test.ts:195-266`. (a) idle-timer-vs-`ensureStarted` single-flight: **MISSING** — the `this.starting` guard in `armIdleTimer`/`idleTeardown` (`runtime.ts:245,261`) is never raced against a timer fire. (b) analyze mid-soft-teardown: **sequential** (`:196-214` `sleep(60)` lets teardown finish at `:206` before the next analyze at `:209`; `FakeChild.kill` resolves on a microtask so the overlap window never opens). (c-soft) `stop()` during an in-flight soft teardown: **uncovered** (`:255` calls `stop()` before the timer fires, testing "cancel a pending timer", not "await `idleTeardownPromise`" at `runtime.ts:227`). (e) timer `unref` (`runtime.ts:251`): **no assertion**. (c-start) `stop()` during in-flight start **is** deterministic (`:169`, gated `/health`). | Inject a controllable clock (or a `stop()` whose `server.stop()` is gated) so the overlap window is held open; then assert the guard branches actually fire. |
| **TEST-3** | LOW | Test/QA | §17 row 11 ("Images path does not call the OCR engine and does not write `documents`/`ocr_json`") has **no test**. True by construction today, but unguarded against future regressions. | No vision test references OCR or `ocr_json` (grep). | Add a guard test asserting the vision analyze path never touches the OCR engine or writes `documents`/`ocr_json`. |
| **TEST-4** | LOW | Test/QA | §17 rows 2 & 3 say "client **+** main guard"; the **client-side** `unsupportedType` and the **over-dimension `tooLarge`** reject have no test (no `decode.ts` test exists). The main guard is well covered. | client reject `ImagesScreen.tsx:170-177`, dimension cap `decode.ts:84-87`; no `decode.test.ts` (Glob empty); `ImagesScreen.test.tsx` never feeds an unsupported file or an over-dimension image. Main guard covered at `images-ipc.test.ts:145,155,238,246`. | Add a `decode.ts`/`ImagesScreen` test feeding an unsupported MIME and an over-dimension bitmap. |
| **SEC-1** | LOW/NIT | Security | Plan §12 narrows vision logs to "a count, a jobId, the file **extension**, a size class". The `readBytes` stat-failure log can carry the **full file path** (an fs error string), exceeding "extension only". Not image/prompt/answer content, so the §0 hard redline holds. | `registerImagesIpc.ts:99` `log.warn('Vision readBytes stat failed', { error: String(err) })` — `String(err)` of an ENOENT/EACCES includes the path. (The only other vision log, `index.ts:138`, carries `jobId` + a content-free error string — clean.) | Log `{ ext: imageExtensionOf(path), code: err.code }` instead of the raw error string, or accept it as consistent with the app-wide diagnostics-log path stance and relax the §12 wording. |
| **UX-NIT-1** | NIT | Product/UX | i18n key `images.answer.clear` ("New image"/"Neues Bild") is defined in both catalogs but used nowhere (the "Clear / New image" affordance folded into the preview's Remove/Replace). Dead key. | `en.ts:1468`, `de.ts:1526`; grep for `answer.clear` in renderer → no use. `ImagePreview.tsx:57-64` carries Remove/Replace. | Drop the unused key from both catalogs, or wire it. |

### Doc inaccuracies

| ID | Sev | Persona | Claim vs reality | Evidence | Remediation |
|----|-----|---------|------------------|----------|-------------|
| **DOC-1** | MEDIUM (doc) | Docs / UX | user-guide + troubleshooting say a second question **"waits until the first finishes"** — implying a queue. The implementation busy-**REJECTS** (discards) the second analyze; nothing is enqueued or auto-run. The design record itself says "returns `busy`, never queued". | Doc: `user-guide.md:514`, `troubleshooting.md:251`. Code: `index.ts:78` `return failedJob('busy')`; `QuestionComposer` disabled while analyzing; design record `architecture.md:2442,2487`. | Reword to "you can only ask one question at a time — wait for the current answer (or press **Stop**) before asking the next." |
| **DOC-2** | NIT | Docs | The §9 anchor legend (plan-§ → record-§) omits a row for the renderer's `§5.1`–`§5.6` anchors, which in-code comments cite. A reader chasing `§5.3` from `ImagePreview.tsx` has no legend entry. | Legend `architecture.md:2583-2602` (no §5.x row). Cited in `VisionUnavailable.tsx:6` (§5.1), `ImageDropZone.tsx:5` (§5.2), `ImagePreview.tsx:6`/`QuestionComposer.tsx:5` (§5.3), `AnswerThread.tsx:6` (§5.4), `QuestionComposer.tsx:7` (§5.5). | Add a `plan §5.1–§5.6 → record §5 / §4 state matrix` row to the legend. |

---

## Per-persona notes

**1. Security & Privacy — CLEAN on every hard redline.** Loopback: the sidecar binds `127.0.0.1`
only (`sidecar.ts` `LOOPBACK_HOST`, `--host 127.0.0.1`); the security test asserts every fetch URL
hostname is `127.0.0.1` (`vision-security.test.ts:150`). No content leak: the *only* two log calls in
the whole vision path are `index.ts:138` (jobId + content-free error string) and
`registerImagesIpc.ts:99` (stat error — see SEC-1); no audit row is ever written (`audit` not called;
asserted `:158,192`). CSP unchanged: `main/index.ts:380` (dev) and `:382` (prod) are both
`img-src 'self' data:` with **no** `blob:` and no remote origin in `connect-src`; the preview renders a
`data:` URL only (`ImagePreview.tsx`, `decode.ts`). No temp file: bytes are base64-inlined into the
request body (`runtime.ts:179`) — the §12 file-path fallback was not built (V1 = base64, no disk).
SEC-3 enforced on **both** entrypoints: `imageReadBytes` re-validates extension + cap
(`registerImagesIpc.ts:92,102`); `analyze` re-validates MIME + cap (`limits.ts:47-54`). Path-trust is
the documented, accepted `importDocuments` stance (not a new finding). IPC error strings are friendly
constants only (`IMAGE_UNSUPPORTED_MESSAGE`/`IMAGE_TOO_LARGE_MESSAGE`/localized "locked") — no content.

**2. Runtime / Concurrency — RUNTIME-4 interlock is correct on a full static walk.** I traced every
interleaving in `runtime.ts`:
- *Idle timer vs single-flight start*: `armIdleTimer` arms only when `!stopped && !starting &&
  inFlight===0 && server` (`:245`); `analyze()` calls `cancelIdleTimer()` **and** `inFlight++`
  *before* awaiting `ensureStarted` (`:165-166`), and `ensureStarted` cancels again (`:118`). A timer
  can never fire during a start (single-threaded; `idleTeardown` re-checks the same guard synchronously
  at `:261` before its first await). ✓
- *Analyze mid-soft-teardown*: `idleTeardown` nulls `this.server` **synchronously** before awaiting the
  kill (`:265`), so a concurrent `analyze` sees `server===null` and cold-starts an independent child;
  the old child finishes stopping under `idleTeardownPromise`. ✓
- *stop() during start or soft teardown*: `stop()` awaits both `this.starting` and
  `this.idleTeardownPromise` (`:226-227`) before nulling/stopping — no orphan on quit/lock. ✓
- *inFlight arming/disarming*: `++` before try, `--` in `finally`, re-arm only at `inFlight===0`
  (`:166-174`). Correct for overlapping callers (note: the service busy-rejects, so in production only
  one job ever reaches `runtime.analyze`). ✓
- *Timer unref*: `:251` `this.idleTimer.unref?.()` — never keeps the process alive. ✓
- *Args*: does **not** inherit `CHAT_SERVER_ARGS`; passes `--mmproj <proj>` + `--device none` only
  (`runtime.ts:32,130`), no `--jinja`, no `--reasoning-format` — exactly the V1-resolved set.
  Vision's **own** one-job serialization + busy-reject live in `index.ts:78` (RUNTIME-3/IPC-3). ✓
- Lock teardown wired at `registerWorkspaceIpc.ts:245` (`ctx.vision?.stop()` in the lock
  `allSettled`); quit teardown at `index.ts:473`. `VisionService.stop()` aborts the in-flight job and
  nulls `this.runtime` so the next analyze rebuilds a fresh runtime (cold start) — no `suspend`/latch
  needed (`index.ts:176-183`). ✓
No implementation bug found. The only gap is **test strength** (TEST-2).

**3. Test / QA — see TEST-1…4.** No forbidden fake-answer injection in the production path:
`createRuntime` is the allowed test seam; when `status.available===false` the service `fail`s with
`runtimeFailed` and never builds a runtime (`index.ts:99-101`; asserted `images-ipc.test.ts:170`).
The manual smoke file is correctly **collected** by `full-suite-guard.ts` (recursive, no `manual`
exclusion) **and skipped** without `HILBERTRAUM_VISION_SMOKE` (`vision-smoke.test.ts:49`
`describe.skipIf(!enabled)`) — can neither false-green nor run in CI. `chart.png` is a valid, tiny
(1734 B), content-free PNG and `make-fixtures.mjs` regenerates it **byte-identically** (deterministic;
no RNG/timestamps) — running it leaves the tree clean. The SSE regression
(`vision-sse.test.ts`) is genuinely strong (mid-UTF-8 byte-chunking reconstructs `Müller & Söhne`).

**4. Docs — see DOC-1, DOC-2.** Otherwise unusually faithful: all 10 spot-checks (args, idle
120000 ms / `HILBERTRAUM_VISION_IDLE_MS`, two-file install, `data:`-only + CSP, loopback, ctx 4096,
20 MiB cap, file paths, license, renumbering) matched the code. model-benchmarks §8 numbers are
traceable to BUILD_STATE V1 (peak RSS ~4.6 GB, ~52 s prefill, ~2813 image tokens, Q4_K_M 1.93 GB +
f16 mmproj 1.34 GB with matching SHAs) — no invented figures. Qwen2.5-VL `license_review`
(Apache-2.0, ggml-org provenance) is recorded in `model-policy.md:347-355`. No doc references the
deleted plan file as live.

**5. Product / UX — honesty posture holds.** All 14 §5.6 states have real handling (unavailable/
empty/selected/starting/busy/no-question/too-large/unsupported/decodeFailed/multi-drop/analyzing+Stop/
runtimeFailed/emptyResponse/new-image-mid-analysis/locked). "Generated locally from the selected
image." renders on `done` turns; only friendly codes are ever shown (no raw model/runtime text); the
thread is ephemeral. IA: `design-guidelines.md §2` updated to "6 primary + 1 utility"; nav order is
Documents → Images → AI Model; EN/DE key parity is exact, German informal "du". Limit copy is truthful
except DOC-1.

**6. Distribution / Packaging / Licensing — see DIST-1, DIST-2.** Safe today: **no committed
`role:vision` manifest** (grep of `model-manifests/**` → none), so nothing vision ships and the two
HIGHs are latent. Install-state requires both files (`manifestFiles`, `computeInstallState` — PASS);
drive dirs `models/vision` + `model-manifests/vision` are in `DRIVE_LAYOUT_DIRS` and both prepare-drive
scripts (PASS); forward-compat holds (an older build's `ROLES` allow-list rejects `role:vision` as a
validation error, not a crash — PASS); the manifest validator enforces mmproj-required-iff-vision,
non-empty `local_path`, real-or-placeholder sha, and `mmproj.download.sha256 == mmproj.sha256` (PASS).

---

## Plan-completeness checklist

**Phase V5 tasks (plan §16):**

| Task | Status | Evidence |
|------|--------|----------|
| V5.1 — benchmark fixtures + `HILBERTRAUM_VISION_SMOKE` manual harness; numbers in model-benchmarks | **DONE** | `tests/fixtures/vision/{chart.png,make-fixtures.mjs,vision-sse-sample.txt}`; `tests/manual/vision-smoke.test.ts` (env-gated, skipped in CI); `model-benchmarks.md §8`. |
| V5.2 — full test suite + sentinel (no content in logs/audit; no remote network) | **DONE (with weaknesses)** | Suites listed below; sentinel `vision-security.test.ts` — but content-leak half is weak (TEST-1). |
| V5.3 — fold plan into architecture.md §1–§9 + model-policy/drive-layout/packaging/known-limitations + user guide/troubleshooting; delete plan file | **DONE** | Design record `architecture.md` §1–§9; plan file deleted (confirmed in git history HEAD~1). DOC-1/DOC-2 are accuracy nits, not missing work. |
| V5.3 — commercial gates "only if a vision model is shipped" (then verify GGUF + mmproj) | **DEFERRED / GAP** | Correctly deferred (no vision drive ships), **but** the gate as written would not verify the mmproj even when reached — DIST-2. |

**Acceptance criteria (plan §20):**

| Criterion | Status | Evidence |
|-----------|--------|----------|
| "Images" nav item after Documents, before AI Model; routes | **DONE** | `App.tsx` NAV_TOP; `navigation.ts`. |
| No vision model ⇒ calm copy, routes to AI Model, OCR pointer, app launches, tests pass | **DONE** | `VisionUnavailable.tsx`; green-gate. |
| Compatible model+projector+runtime ⇒ drop/choose PNG/JPEG, ask, locally-generated answer | **PARTIAL** | Runtime path built + manually smoke-verified, **but** in-app download can't deliver the mmproj (DIST-1) — model must be hand-placed for now. |
| No cloud/network/hosted-AI/telemetry | **DONE** | Loopback-only, verified (`vision-security.test.ts:150`). |
| No image/prompt/answer/OCR/field content in logs or audit | **DONE** (minor SEC-1 path-in-log nit) | Two content-free log calls; zero audit rows. |
| Missing/incompatible runtime/model/projector does not crash | **DONE** | `status.ts` returns `available:false`; `run()` fails gracefully. |
| Renderer sandboxed + typed preload; sidecar binds 127.0.0.1 | **DONE** | `preload/index.ts`; `sidecar.ts`. |
| Clearly separate from OCR/Documents (no auto-OCR/import/corpus writes) | **DONE** (unguarded — TEST-3) | True by construction; no test enforces it. |
| CSP not weakened; no native npm dependency | **DONE** | `img-src 'self' data:` (no blob:); decode uses browser APIs only (`decode.ts`). |
| Docs explain feature + limits honestly | **MOSTLY** | DOC-1 (busy-reject wording). |
| Tests pass with zero vision models | **DONE** | `npm test` (this audit) = **1965 passed / 30 skipped**, 161/177 files, 45 s, exit 0 — with no vision models installed. |

---

## Test-coverage verdict (plan §17)

| §17 row | Test(s) | Verdict |
|---------|---------|---------|
| Status detection (no-runtime/no-model/incompatible/available; mmproj-missing ⇒ not available) | `vision-status.test.ts:78,87,94,105,118,129` | **COVERED** |
| Supported/unsupported file handling (client + main) | `images-ipc.test.ts:145,238` (main) | **WEAK** — client guard untested (TEST-4) |
| Size limits (over-byte / over-dimension) | `images-ipc.test.ts:155,246` (byte) | **WEAK** — over-dimension untested (TEST-4) |
| Manifest validation (vision requires mmproj; sha equality; unknown keys; non-vision unaffected) | `manifest.test.ts:192,201,209,215,221,227,243,253,266,277,282` | **COVERED** (strongest block) |
| IPC contract (DTOs; unknown jobId ⇒ failed; busy) | `images-ipc.test.ts:97,119,137,184,196` | **COVERED** |
| Preload exposure typed | `preload-vision.test.ts:36,53,60,66` | **COVERED** |
| Renderer states (+ chip fills / Remove resets / new-image cancels) | `ImagesScreen.test.tsx:82,97,107,114,144,157,181,197,214,232,251` | **COVERED** |
| Security sentinel (no content in log/audit; no-remote) | `vision-security.test.ts:112,161` | **WEAK** — content-leak half partly vacuous (TEST-1); loopback + audit halves genuine |
| SSE parser regression | `vision-sse.test.ts:41,48` | **COVERED** (strong) |
| Runtime smoke (env-gated) | `vision-smoke.test.ts:49` | **COVERED** (collected + skipped) |
| OCR-unchanged regression | — | **MISSING** (TEST-3) |
| RUNTIME-4 idle races | `vision-runtime.test.ts:195-266` | **HAPPY-PATH/SEQUENTIAL** — only `stop()`-during-start is deterministic (TEST-2) |

Tests that could pass without exercising their target: the security content-leak assertions (TEST-1)
and the RUNTIME-4 `this.starting` guard branches (TEST-2). No forbidden fake-answer injection found.

---

## Severity tally

- **CRITICAL:** none.
- **HIGH:** 2, both **latent** (DIST-1, DIST-2) — track before the first vision drive; not a merge blocker.
- **MEDIUM:** 3 (TEST-1, TEST-2, DOC-1).
- **LOW:** 3 (TEST-3, TEST-4, SEC-1).
- **NIT:** 2 (UX-NIT-1, DOC-2).

A clean bill of health on every §0 hard redline (offline, loopback, no content leak, CSP intact, no
native dep, graceful zero-model) and on the RUNTIME-4 implementation. Recommend merging once DOC-1 is
corrected and DIST-1/DIST-2 + TEST-1/TEST-2 are filed as tracked follow-ups (DIST-1/DIST-2 are
hard blockers for shipping an actual vision model, but not for landing this branch).
