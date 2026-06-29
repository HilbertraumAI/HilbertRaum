# BUILD STATE — HilbertRaum

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`CLAUDE.md`](CLAUDE.md)).
> It carries: current status, decisions, shared data contracts, next actions, open issues.


_2026-06-29 — **Full audit 2026-06-29 remediation — Phase 4 (RENDERER LIFECYCLE + DETERMINISM/ROBUSTNESS
LOW-HANGERS; FE-1/RAG-1/RAG-2/REL-4) — branch `full-audit-2026-06-29-fixes`.** Suite now **2456 passed /
39 skipped (2495 collected)** (was 2446/39 at Phase 3 → **+10 tests**), typecheck clean, `npm run build`
green. All four are LOW (quality/reproducibility/robustness, not user-harm); each was test-first
teeth-checked (write the failing/observable test → confirm it reddens on current code → fix → green →
revert→fail→restore). Two commits: FE-1 (renderer), then RAG-1/RAG-2/REL-4 (main-process
determinism/robustness).
- **FE-1 (LOW) — `ChatScreen` setState-after-unmount in the attach poll + stream flush
  (`ChatUnmount.test.tsx`, NEW, +1).** The FE-4-class gap the sibling screens already guard: the
  attach-import poll (`watchAttachJob`) and the streamed-token flush (`flushStream`) both resolve after
  the user can navigate away mid-import / mid-generation. Added a `mountedRef` (gating the poll/flush
  setStates) and a flush-timer `clearTimeout` on unmount. **Hard constraint honoured:** the main-side
  stream is NOT torn down — it is intentionally recovered on remount via `getActiveStream`; the change is
  guard-only. Test unmounts with a poll tick AND a flush timer in flight; teeth on both (the late tick must
  not re-fetch `listDocuments`; the flush timer must be `clearTimeout`'d).
- **RAG-1 (LOW) — tied vector/keyword scores got nondeterministic per-list ranks before RRF
  (`hybrid-search.test.ts`, +2; `resident-cache.test.ts` oracle aligned).** Neither input list had a
  secondary key, so equal-score ties inherited V8 sort stability (vector) / SQLite's unspecified `bm25()`
  order (keyword) — which chunk won a page-dedup slot could flip across SQLite versions/query plans (a
  reproducibility/flake risk, NOT a hallucination). Added a `chunkId` tiebreak to BOTH: the vector sort in
  `embeddings/index.ts` (`score desc, chunkId asc`) and the FTS `ORDER BY bm25(...), chunks_fts.chunk_id`.
  The resident-cache equivalence oracle was updated to the same deterministic order (it is the reference
  ranking). Teeth: dropping either tiebreak reddens the new equal-score tests; the other 19 hybrid tests
  stay green (ranking algorithm unchanged — only ties are now total).
- **RAG-2 (LOW) — `truncateSnippet` could split a surrogate pair (`snippet-truncate.test.ts`, NEW, +2).**
  `String.slice(0, 600)` cuts on a UTF-16 code unit; an astral char (emoji/CJK ext-B/math) straddling the
  boundary left the citation snippet ending in a lone surrogate (`�`, display-only). Now counts AND slices
  by code point (`[...trimmed]`). Teeth: revert to `.slice` → the snippet carries a lone surrogate.
- **REL-4 (LOW) — `combineSignals` accrued uncleared per-request timeout timers
  (`combine-signals.test.ts`, NEW, +5).** Each embed/rerank/vision request built `AbortSignal.timeout` +
  `AbortSignal.any`; an early completion (the norm) left the timer (120 s embed/rerank, 300 s vision) and
  its `any`-listener alive for the full duration — a large ingestion accrued thousands. `combineSignals`
  now owns an `AbortController` + explicit `setTimeout` and returns `{ signal, clear }`; all three call
  sites `clear()` in a `finally`. Behaviour preserved (caller-abort AND timeout still abort; timeout reason
  still `TimeoutError`; timer still unref'd). Teeth: skip the `clearTimeout` → a pending timer survives.
- **Docs:** `architecture.md` renderer record (FE-4 bullet) extended with the FE-1 ChatScreen guard;
  `rag-design.md` §11 gained a per-list tie-break determinism note (RAG-1). RAG-2/REL-4 are captured by
  source comments + this entry.
- **NEXT ACTION (owner):** P4 closes the renderer/determinism low-hangers. Remaining phases on this branch:
  P5 resident-cache incremental (PERF-1), P6 docs + close-out (the §26 ledger) + REL-5. Do NOT
  auto-merge/push — left to the owner. (PERF-5 Part B / FE-5 list-windowing stays deferred, untouched.)_

_2026-06-29 — **Full audit 2026-06-29 remediation — Phase 3 (TEST-ENFORCEMENT GAPS; TEST-2/3/4/5 +
TEST-6 docs) — branch `full-audit-2026-06-29-fixes`.** Suite now **2446 passed / 39 skipped (2485 collected)**
(was 2437/39 at Phase 2 → **+9 tests**; TEST-5 was a conversion, not an addition), typecheck clean,
`npm run build` green. **Test-only phase — NO `src/` behavior change** (the only source edits were the
temporary teeth-check neuters, each restored byte-identical; `git diff src/` is empty). The closures
target a class of gap distinct from a bug: a security/reliability control that is correct in isolation
but that no test proves stays *wired* — a silent unwiring (the control stops being *called*) would redden
nothing. Each new test is **teeth-checked** (neuter the guarded control → the test reddens → restore),
and the teeth-check IS the point. Closed with the REAL seam (FakeChild / llama-runtime / transcriber
harness, recording `fetch`, the real `VisionRuntime`), never a new fake that re-creates the bypass.
- **TEST-2 (MEDIUM) — spawn seams re-hash before spawn (`tests/integration/binary-verify-spawn.test.ts`,
  NEW, +4).** The verdict/cache matrix is well unit-tested and each seam HAD a refusal test — but those
  inject a fake `verifyBinary: () => 'mismatch'`, proving only the verdict→refusal mapping, not that the
  seam still CALLS the real verifier. The new tests drive the REAL `verifyBinaryBeforeSpawn` end-to-end at
  all three seams (`LlamaServer.start`, the GPU `--list-devices` probe, `whisper-cli`) with PACKAGED
  enforcement ON + a real on-disk marker whose recorded hash mismatches the bytes → each refuses to spawn
  (no child). A matching-marker positive control proves the refusal is the hash mismatch, not an
  always-refuse. Teeth confirmed: removing the verify guard at each seam reddens its refusal test
  (LlamaServer resolves, GPU spawn count 1, whisper proceeds).
- **TEST-3 (MEDIUM) — embed failure propagates at `generateGroundedAnswer`, not just `retrieve()`
  (`tests/integration/rag.test.ts`, +1).** TEST-N8 proves `retrieve()` rejects on a failing embedder, but
  `generateGroundedAnswer` early-returns NO_DOCUMENT_CONTEXT/REINDEX_NEEDED on empty chunks — a regression
  wrapping `retrieve` in `try/catch → []` would make a transient embed fault MASQUERADE as "no documents".
  The new test uses a FRESH failing embedder (defeats the per-instance query LRU) over a NON-EMPTY corpus
  and asserts `generateGroundedAnswer` REJECTS. Teeth confirmed: swallowing `retrieve` into [] makes it
  resolve with the no-context answer and the test reddens.
- **TEST-4 (LOW) — installer coded error constants (`tests/integration/skills-installer.test.ts`, +4).**
  `encryptedZip` (BOTH the GP-flag bit-0 path AND the `0xFFFFFFFF` ZIP64-sentinel path — `writeRawZip`
  extended with optional `gpFlag`/`uncompressedSizeOverride`), `invalidPath` (the SEC-N1 NUL-byte
  content-leak defence — asserts the FIXED reason never echoes the crafted name), and `pathTooLong` (small
  `maxPathLen`) are each driven through the real `previewSkillPackage`/`importSkill` (fixed reason + stable
  `errorCode`, never throws raw / leaks a path). The "never routes through tar" test is relabelled
  **documentation-only** (a source grep — no runtime call site exists to intercept). Teeth confirmed: each
  of the 4 reddens with its named guard neutered; the other 23 stay green.
- **TEST-5 (LOW) — real `VisionRuntime` success-path no-leak (`tests/integration/vision-security.test.ts`,
  CONVERTED in place).** The success-path no-leak test used a hand-written fake `analyze`, bypassing the
  real runtime's data-URL request construction + SSE parsing. It now routes through the REAL `VisionRuntime`
  (recording `fetch` + an SSE body) so the prompt + image bytes pass through `runAnalyze` → `server.fetch` →
  `readChatSSE`, then asserts no log line carries the prompt/answer/base64-image. Teeth confirmed: logging
  `opts.question`/the data-URL at the runtime layer reddens it.
- **TEST-6 (INFO) — no automated answer-quality floor in CI (docs-only).** Recorded in `architecture.md`
  "Test-enforcement seams — design record (Phase 3)": retrieval/answer/skill-trigger ACCURACY has no
  automated floor that fails CI — the `eval/skill-triggers` harness prints precision as a MEASUREMENT (the
  S13b precision-bar assertion is owner-gated on D1, §18) and the real-model quality benchmarks are
  env-gated out of CI by design (model-benchmarks.md D19); accuracy regressions are caught only by the
  manual smoke matrix. Follow-up: land the S13b bar once the owner sets D1.
- **Docs:** new non-numbered `architecture.md` "Test-enforcement seams — design record (full audit
  2026-06-29, Phase 3)" subsection (records TEST-2…6 + the teeth-check rationale); Phase 6's §26 ledger can
  point to it. No new BUG surfaced by the added coverage (the controls are correct; only the wiring was
  untested).
- **NEXT ACTION (owner):** P3 closes the highest-value test-enforcement gaps. Remaining phases on this
  branch: P4 renderer/determinism (FE-1/RAG-1/RAG-2/REL-4), P5 resident-cache incremental (PERF-1), P6 docs
  + close-out (the §26 ledger) + REL-5. Do NOT auto-merge/push — left to the owner._

_2026-06-29 — **Full audit 2026-06-29 remediation — Phase 2 (RUNTIME RELIABILITY; REL-1/REL-2/REL-3 +
DOC-2) — branch `full-audit-2026-06-29-fixes`.** Suite now **2437 passed / 39 skipped (2476 collected)**
(was 2426/39 at Phase 1 → **+11 tests**), typecheck clean, `npm run build` green. Process-lifecycle /
concurrency fixes only — no schema, IPC, or audit-payload change. Each finding fixed **test-first** through
the real seams (FakeChild / llama-runtime / transcriber / arbiter harnesses), reproduction confirmed RED
before the fix (the REL-2 tests hung→timed-out RED; the REL-3 chat-stream test threw on the un-threaded
signal), with the existing GPU-ladder / forceRestart / LlamaServer.stop / dictation suites green after each.
One commit per finding (fed7464 REL-1, e8f92d0 REL-2, 4061d7c REL-3, + the docs commit for DOC-2 / folding).
- **REL-1 (MEDIUM) — port-race TOCTOU mis-attributed to "GPU broke" (`runtime/sidecar.ts`, `factory.ts`).**
  `findFreePort` binds port 0, reads the port, then CLOSES the listener before the child binds — a sibling
  sidecar (chat+embedder+reranker+vision start near-simultaneously) can steal it → child exits "address
  already in use". (a) `LlamaServer.start` now retries `doStart` **once** on a bind-class immediate exit
  (`isBindRaceError`) on a fresh port — covers chat AND the embedder/reranker/vision (which had NO retry).
  (b) The GPU ladder no longer persists `gpuAutoDisabled` when a rung-1 failure is a bind race rather than a
  device fault, so one port collision can't disable GPU for the session. **Diverged from the audit's literal
  `…(?:-(?!…))` regex suggestion? No — that was BL-1; here the audit's directional `onGpuFailure`-narrowing
  was implemented via the shared `isBindRaceError` classifier so the retry and the ladder agree.**
- **REL-2 (MEDIUM) — whisper kill never escalated to SIGKILL → wedged child hangs quit/lock
  (`transcriber/cli.ts`).** The watchdog, abort handler, and `suspend()`/`stop()` sent bare `child.kill()`
  (SIGTERM) and awaited `close`; a child wedged in native code that ignores SIGTERM never emits `close`, so
  the slot stayed held and teardown hung indefinitely with the transcript transient on disk. New
  `killWithEscalation` mirrors `LlamaServer.stop()` (SIGTERM → SIGKILL after `killGraceMs`=2 s, grace timer
  unref'd + cleared on clean exit), wired into all three kill sites; `suspend()`/`stop()` bound the cleanup
  await with `suspendTimeoutMs`=10 s (crash-sweep is the shred backstop past the cap).
- **REL-3 (MEDIUM) — "Stop" unresponsive while a deep-index build holds the slot (`ipc/chat-stream.ts`,
  `analysis/model-slot-arbiter.ts`, `doctasks/manager.ts`).** `withChatStream` awaited `acquireSlot()` with
  no signal; a Stop during the multi-second node-`generate` park aborted a controller nobody watched.
  `acquireForChat(signal?)` now threads the turn's signal (new `waitForHandoff`): a Stop during the park
  rejects at once, removing the waiter from the queue + giving back its `chatHolders` slot + dropping the
  pause when it was the last waiter. `withChatStream` resolves that Stop cleanly via `done` (empty message),
  never `chat:error`. All 7 call sites (registerChatIpc + 6 registerRagIpc) forward `controller.signal`.
- **DOC-2 (LOW) — `architecture.md` GPU table said "60 s health timeout"; code is 180 s
  (`DEFAULT_HEALTH_TIMEOUT_MS`).** Corrected to "180 s (3 min)". Folded the REL-1 (§5.5), REL-2 (transcriber
  watchdog bullet), and REL-3 (doc-task arbiter bullet) as-built notes into `architecture.md`;
  `known-limitations.md` extended with the REL-2 SIGKILL/teardown residual.
- **REL-5 (LOW) — DEFERRED (per the audit's own recommendation).** `BEGIN IMMEDIATE` + a `withTransaction`
  guard touches every `db.exec('BEGIN')` site (chat/doctasks/tree-build/node-vectors/skills) — a broad,
  correctness-sensitive refactor that deserves its own characterized phase, not a ride-along here. **Still open.**
- **NEXT ACTION (owner):** REL-2 (hang-on-quit) was the strongest should-fix here — closed. Remaining phases:
  P3 test-enforcement gaps (TEST-2…5), P4 renderer/determinism (FE-1/RAG-1/RAG-2/REL-4), P5 resident-cache
  incremental (PERF-1), P6 docs + close-out (the §26 ledger) + REL-5. Do NOT auto-merge/push — left to the owner._

_2026-06-29 — **Full audit 2026-06-29 remediation — Phase 1 (FINANCIAL CORRECTNESS; BL-1/BL-2/BL-3) —
branch `full-audit-2026-06-29-fixes`.** Suite now **2426 passed / 39 skipped (2465 collected)** (was
2417/39 at Phase 0 → **+9 fixtures**), typecheck clean, `npm run build` green. Parsing/categorization only
— no schema, IPC, or audit-payload change (figures stay content-class). Each finding fixed **test-first**
through the REAL entry points (`extractTransactionRows`/`reconcileBalances`/`summarizeCashflow`/
`categorizeRow`/`prefilterCategory`), reproduction confirmed RED before the fix, with the pre-existing
money/bank/invoice suite green after each. One commit per finding (6d5eea2 BL-1, 71c3fb8 BL-2, 3a3e93a BL-3).
- **BL-1 (HIGH, release-blocking) — leading-minus sign theft (`money.ts MONEY_RE`).** The trailing
  `\s*\)?-?` reached across the column gap and stole the NEXT figure's leading minus, so `2.500,00 -500,00`
  parsed as amount −2500 / balance +500 (BOTH flipped); the uniform flip kept the running chain consistent,
  so `reconcileBalances` blessed the wrong figures `ok`. Fixed with a **space-disambiguated** trailing region
  `(?:-|\s*\)|\s+-(?!\s*[-+(]?\d))?`: a GLUED `-` is a de-AT debit (always consumed), a `-<digit>` after a
  space is the next figure's leading sign (left alone). **Deliberately diverged from the audit's literal
  `(?:-(?!\s*[-+(]?\d))?` suggestion**, which would have regressed the common de-AT row `45,90- 1.908,20`
  (glued debit + running balance) to +45,90 — verified by trace. Stays ReDoS-linear (200k-char test green).
  Residual (known-limitations): a SPACED trailing minus before a balance (`45,90 - 1.908,20`) reads positive
  — indistinguishable from subtraction.
- **BL-2 (MEDIUM) — figure-region currency (`bank-statement.ts parseLine`).** Per-row `detectCurrency(line)`
  scanned the whole line incl. the description, so a `USD`/`$` in a payee memo tagged a EUR row foreign →
  the whole statement's total/reconciliation collapsed to the mixed-currency refusal. Now detects only in the
  **figure region** (`rest.slice(matches[0].index)`), falling back to the statement currency; a genuine
  foreign-currency row (code/symbol next to the amount) is still detected, so mixed-currency honesty holds.
- **BL-3 (MEDIUM, de-AT target) — German closed-compound categorization (`money.ts wordIncludes`).** The C-1
  two-sided boundary stopped de-AT keywords from ever matching a closed compound (`kontoführungsgebühr`),
  dropping fees into Spending. Added a **one-sided COMPOUND** mode to `wordIncludes`; the rule table opts the
  unambiguous DE keywords (`gebühr`/`gehalt`/`überweisung`/`bargeld`) in via `compound: true`. English tokens
  and the ambiguous `lohn` stay STRICT (no C-1 regression); `categorizeRow` + `prefilterCategory` thread the
  flag so the two paths still agree (C-1 invariant). Matching-only — not persisted (`run.ts` seeds only
  `match_kind`/`pattern`). The prior test pinning the now-buggy `Kontoführungsgebühr→Spending` was corrected.
- **Docs:** `architecture.md` §8 — new "Financial correctness (full-audit-2026-06-29, Phase 1)" subsection +
  the `wordIncludes` paragraph; `docs/known-limitations.md` — sign-by-space + figure-region-currency +
  compound-categorization bullets and the residuals, "Last updated" bumped.
- **NEXT ACTION (owner):** BL-1 was the release-blocking item — it is closed. Remaining phases on this branch:
  P2 runtime reliability (REL-1/2/3), P3 test-enforcement gaps (TEST-2…5), P4 renderer/determinism, P5
  resident-cache incremental, P6 docs + close-out (the §26 ledger). Do NOT auto-merge/push — left to the owner._

_2026-06-29 — **Full audit 2026-06-29 remediation — Phase 0 (DE-FLAKE THE SUITE; TEST-1) — branch
`full-audit-2026-06-29-fixes`.** Suite now reliably **2417 passed / 39 skipped (2456 collected)**,
confirmed stable across **3 consecutive full `npm test` runs**; `npm run build` green. Test-only change
(nothing under `src/` touched), so the test count is unchanged from the previous headline — the fix
removed the flake, not any tests; the "2417 passed" claim that the audit flagged as stale/optimistic is
now genuinely held.
- **TEST-1 (High).** `tests/integration/dictation-ipc.test.ts:223` (the REL-3 concurrency test) polled with
  an **iteration cap** (`for (let i = 0; calls === 0 && i < 100; i++) …`) instead of a wall-clock deadline.
  Commit `fa9a6b2` (2026-06-28 audit, PERF-2) moved `await writeFile` to run BEFORE `transcribe()`, so under
  full-suite CPU contention (vitest forked pool) the off-event-loop write didn't complete within 100
  `setImmediate` ticks → `calls` stayed 0 → `expect(calls).toBe(1)` flaked RED. Passed in isolation, flaked
  only under whole-suite load. It was the lone iteration-capped poll in the integration suite.
- **Fix.** Replaced the cap with a wall-clock deadline matching the rest of the suite:
  `const start = Date.now(); while (calls === 0 && Date.now() - start < 5000) await new Promise((r) => setImmediate(r))`.
  Comment updated to explain the deadline + cite TEST-1. The synchronous-`inFlight` BUSY-refusal assertions
  below it (the actual single-flight contract) were untouched — they don't depend on this timing.
- **NEXT ACTION (owner):** Phase 0 unblocks a trustworthy `npm test` baseline for the rest of the audit.
  Remaining phases on this branch: P1 financial correctness (BL-1/2/3, the release-blocking sign-theft),
  P2 runtime reliability (REL-1/2/3), P3 test-enforcement gaps (TEST-2…5), P4 renderer/determinism low-hangers,
  P5 resident-cache incremental, P6 docs + close-out. Do NOT auto-merge/push — left to the owner._


_2026-06-29 — **Doc cleanup: retired `docs/functionality-wave-3-plan.md`.** The wave was complete
(Phases 31–38, 2026-06-11) and its per-feature mechanisms already lived in the topic docs; the unique
"cited-as-a-unit" content (the §13 decisions D23–D37 + the §14 research-gate evidence R-S1/R-T1/R-T2/
R-W1–4/R-O1–3) was folded into a new `docs/architecture.md` **"Functionality wave 3 — design record"**
section (§13 + §14 verbatim) with a **§-anchor legend** mapping the historical `wave-3 plan §4–§15` to
their current homes — the Skills/Image-understanding retirement pattern. The ~30 in-code `wave-3 plan §N`
comments were left unchurned (the legend keeps them resolvable); only the three filename citations
(`doctasks.ts`, `doctasks/manager.ts`, `server-concurrency-probe.test.ts`), the two BUILD_STATE ledger
links (above), and the CLAUDE.md doc-lifecycle rule (which had named the file as its example) were
repointed. The full original plan stays in git history. No code/behavior change; comments + docs only._

_2026-06-29 — **Full audit 2026-06-28 — CLOSE-OUT (Phase 8: DOCUMENTATION RECONCILIATION + audit fold).
The full multi-perspective audit (`audits/full-audit-2026-06-28.md`) is now FULLY REMEDIATED across
Phases 0–8 on branch `full-audit-2026-06-28-fixes`.** Final suite **2417 passed / 39 skipped** (was
2415/39 at Phase 7 → **+2** from the new DOC-N4 parity test); **typecheck + build green**, verified by ONE
full-suite run at close-out — no phase regressed another across the cumulative branch. Phase 8 is
docs/close-out: the ONLY code touches are the DOC-N2 comment fix (×2) + the DOC-N4 parity test;
offline/no-telemetry/behavior-preserving posture held.
- **The §-LEDGER (key deliverable).** New `docs/architecture.md` **§25 "Full audit (2026-06-28) —
  remediation close-out"** (mirrors §24): a per-finding table dispositioning **ALL 54 findings** from the
  report's §1 severity index (REL×5, BL×6, FE×9, TEST×9, PERF×6, RAG×6, DATA×3, SEC×3, DOC×7 — the report's
  "48" headline miscounts its own table; 5 High) → phase → disposition (fixed / docs-only / invariant-only /
  accepted-residual / not-remediated) → the topic-doc § where each as-built record lives. Plus the accepted
  residuals, the not-remediated items, and a verified-clean inventory so the next audit doesn't re-investigate.
- **Two items NOT fully remediated (explicitly dispositioned, surfaced for follow-up):** **REL-3** (Low,
  HYPOTHESIS) — the OCR rasterizer reply waiter stays channel-only (no request-id correlation), bounded by
  the per-step `withTimeout`; never scoped to a phase, accepted. **TEST-N3** (Med) — partially remediated:
  the manual smoke matrix is a deliberate separate human gate (accepted) and the canned-fixture policy +
  the `gpu --list-devices` fixture exist, but the **SSE + whisper-JSON parser fixtures remain OUTSTANDING**
  (open follow-up). Also still open by owner/tracked decision: **PERF-5 Part B** (list windowing, re-deferred)
  and the **E5 prefix-migration TODO** (RAG-N3/DOC-N6 — re-embeds the whole corpus, its own phase).
- **PART 1 — DOC-N1…N7 applied.** DOC-N1: security-model.md now names all SIX `HILBERTRAUM_SKILL_MAX_*`
  caps (was 2/6) + the `HILBERTRAUM_MAX_IMAGE_BYTES`/`_PIXELS` image caps. DOC-N2: `§21 → §22` for the
  bank-statement LLM categorizer in `doctasks/manager.ts` AND `skills/categorizer.ts` (a SECOND stale
  citation the §-anchor sweep found — only manager.ts was named in the report). DOC-N3: README Qwen3.5-4B
  `~2.6 → ~2.9 GB` (manifest = 2,912,109,728 B) + RAM tiers clarified as recommended best-fit vs the
  table's Min-RAM floor. DOC-N4: scoped the "mirrored from assets.ts" claim to the download/verify/plan
  logic; the default-set ids live ONLY in `prepare-drive.{ps1,sh}` (`$DefaultModelIds`/`DEFAULT_MODEL_IDS`)
  — packaging.md + drive-layout.md fixed, and a new `tests/unit/prepare-drive-default-set.test.ts` pins the
  two shells' parity (the optional test, taken). DOC-N5: single-test commands (`npx vitest run <file>`,
  `-t "<name>"`) + `test:watch` added to CONTRIBUTING + README. DOC-N6: VERIFIED already landed (Phase 6 §11
  ceilings note). DOC-N7: packaging.md harness matrix gains an "optional inputs" table for the six
  `HILBERTRAUM_*` artifact-pointer vars (SMOKE_MODEL/GEMMA_MODEL/OCR_IMAGE/REAL_MODEL_PATH/RESIDENT_REAL_N/
  EVAL_DIR).
- **PART 2 — every earlier phase's doc rider verified landed** (a 6-agent read-only verification workflow +
  the §-anchor sweep). All landed as-built EXCEPT one gap, now filled: **BL-N2** was named in the
  known-limitations header/changelog but lacked a prose sub-bullet — added the "Balance/total lines scrub a
  trailing date" sub-bullet. Confirmed landed: REL-1 (§5.3), FE-1 (renderer record), PERF-3/4 + DATA-1/2/3
  (§10 + index inventory), the §24/§10 BL-1 immunity-claim correction, BL-N1/N3/N4/N6 (known-lim),
  RAG-N1/N2/N3/N4/N5/N6 + DOC-N6 (rag-design §2/§3/§11/§12.3/§13.6), SEC-N1/N2/N3 (security-model), TEST-N1
  CI section + TEST-N9. **§-anchor integrity:** 28 distinct code-comment doc-§ citations checked — the ONLY
  dangling one was the DOC-N2 §21 slip (both instances now fixed); all others resolve.
- **PART 5 — report retired (owner ratified commit-then-delete).** `audits/full-audit-2026-06-28.md` turned
  out to be ALREADY tracked/committed in git (since `f1fce73`, contrary to the phase brief's "untracked"
  assumption), so the full original is already recoverable in history; it is `git rm`'d in the Phase-8
  close-out commit (the "commit" half was already satisfied). The folded topic-doc §§ + the §25 ledger are
  the durable record.
- **Headline per phase:** P0 CI pipeline + whisper-smoke leak; P1 financial correctness (date-locale
  inference, trailing-date scrub, amount-by-position, phone/IBAN, grouped figures); P2 GPU crash
  `forceRestart`; P3 React error boundary + renderer lifecycle; P4 CJK/Thai audio+chunker token-awareness;
  P5 data-layer atomicity + 2 indexes + FTS guard; P6 reranker full-chunk scoring depth; P7 ingestion edge
  cases + security/test/perf polish; P8 docs reconciliation + this close-out.
- **NEXT ACTION (owner):** **merge `full-audit-2026-06-28-fixes` to `master` when ready — do NOT
  auto-merge/push.** Before merge, optionally run the `HILBERTRAUM_*` manual smoke matrix (the separate
  human pre-release gate CI does not cover). Outstanding follow-ups for a future wave: the TEST-N3 SSE +
  whisper-JSON canned fixtures, PERF-5 Part B windowing, and the E5 prefix migration._


_2026-06-29 — **Full audit 2026-06-28 remediation — Phase 7 (INGESTION EDGE CASES + SECURITY / TEST / PERF
POLISH; the catch-all of remaining Low/Med items — 13 findings in 4 independent groups: RAG-N4/N5/N6,
SEC-N1/N2/N3, TEST-N5/N7/N8, PERF-1/2/5/6) — branch `full-audit-2026-06-28-fixes`.** Suite **2415 passed /
39 skipped** (was 2398/39 at Phase 6 → **+17 tests**); typecheck + build clean after every group. Committed
incrementally per group (e9a26ba A, 013e2be B, 1380cb0 C, fa9a6b2 + 036c8cc D). Every behavioral fix got a
test, teeth-checked (neuter → fail → restore) and restored byte-identical; offline / no-telemetry /
behavior-preserving posture held.
- **GROUP A — ingestion edge cases (e9a26ba; +6 tests).** RAG-N4: `MarkdownParser` tracks an in-fence flag
  (toggled on each triple-backtick / `~~~` line) and suppresses ATX-heading detection inside a fenced block,
  so a `#` shell-comment / C `#define` / diff hunk no longer fragments the code block + stamps a bogus
  sectionLabel; non-fenced Markdown byte-identical. RAG-N5: `CsvParser` pins the delimiter by extension (`\t`
  for .tsv, `,` for .csv) instead of papaparse auto-detection, which could tie tab with comma on a .tsv whose
  cells contain commas and mis-pair header:value silently. RAG-N6: **already fixed** — `corpusNeedsReindex`
  routes through the shared `buildScopeFilter` (Collections core 5c70021), which applies the same archived
  exclusion as retrieval; **no code change**, added regression tests pinning that an all-archived
  (embedder-invisible) scope answers NO_DOCUMENT_CONTEXT (not REINDEX_NEEDED), with `includeArchived` flipping
  the verdict. Teeth: neuter the fence flag / the .tsv delimiter / the archived `NOT EXISTS` — each fails its test.
- **GROUP B — security polish (013e2be; +1 test).** SEC-N1: a `.skill.zip` member name with an embedded NUL
  passed `safeRelPath` (it checked ../ /drive/depth, not control chars), reached `writeFileSync`, and threw
  ERR_INVALID_ARG_VALUE whose RAW message embeds the attacker path — `previewSkillPackage` (no catch around the
  write; IPC handler none) serialized it to the renderer, breaking the "never throws / returns ok:false"
  contract + §22-M1. Fix, two layers: `safeRelPath` rejects a NUL with a fixed `invalidPath` reason BEFORE any
  write, AND `previewSkillPackage` wraps its materialize/validate body in a catch mapping any residual throw to
  a fixed reason; the new `invalidPath` is wired through the renderer error-code map + en/de i18n. SEC-N2:
  benchmark handlers (`runBenchmark`/`tryGpuAgain`) gained an explicit `requireUnlocked()` (localized
  `main.benchmark.locked`, new en/de key) for parity. SEC-N3 (Info): the `serverMessage` structural-only
  invariant pinned with a comment + accepted as an Info residual (local loopback sidecar, structural bodies,
  500-char cap) in security-model.md. Teeth: neuter `safeRelPath`'s NUL check → falls to `unreadableZip`;
  neuter both layers → preview throws the raw error.
- **GROUP C — test quality (1380cb0; +5 tests, no source change).** TEST-N5: workspace-vault L-6 now asserts
  the OBSERVABLE (the actual key buffer is all-zero after the wrong-password throw, via a passthrough deriveKey
  spy) instead of spying `Buffer.prototype.fill`; skills-analysis bank/invoice read-count `=== 1` relaxed to
  `≤ 1`; skills tool audit-event exact ARRAYS → toContain/not.toContain. TEST-N7: a fixed LE byte-layout
  assertion for `decodeVector` (`[00 00 80 3f] → [1.0]`) independent of encode (catches a symmetric endianness
  bug). TEST-N8: a STRUCTURAL locked-vault test enumerating every registered chat handler (+ the benchmark
  handlers from SEC-N2) asserts each DB-touching one refuses with the friendly copy (never the raw vault
  string), with the 2 in-memory handlers an asserted exemption; plus a retrieve()-level rejecting-embedder test
  asserting the query-embed failure PROPAGATES (not a silent "no documents"). Teeth: swallow the retrieve embed
  reject / drop `key.fill(0)` / neuter the chat guard — each fails its test.
- **GROUP D — performance (fa9a6b2 PERF-1/2/6; 036c8cc PERF-5; +5 tests).** PERF-1: `imageReadBytes` converted
  to fs/promises (open → fh.stat() → fh.read() loop → fh.close() in finally), PRESERVING the SEC-3/TOCTOU
  same-handle invariant + byte cap + content-free open-failure log. PERF-2: dictation WAV write → `await
  writeFile` (handler already async; finally still shreds). PERF-6: `AnswerThread` extracts a memoized TurnRow;
  the in-flight turn renders PLAIN TEXT and Markdown is parsed once on completion (chat FE-1 split). PERF-5
  **Part A only**: `DocRow = memo(...)` fed per-row booleans (`selected`/`menuOpen`) + a parent-narrowed
  `rowTask` (+ stable `anyTaskActive`) + stable `useEventCallback` handlers (extracted to a shared
  `renderer/lib/` module), so a 400 ms task tick / menu-open / sibling-selection re-renders ONLY the affected
  row; FE-7 poll cadence + FE-4 mount guards untouched. **OWNER DECISION: PERF-5 Part B (list windowing)
  RE-DEFERRED** — no virtualization lib in deps; variable-height rows + scroll/find-in-page/a11y are
  behavior-sensitive (the thrice-deferred FE-5; recorded in architecture.md). Teeth: drop `await fh.close()`
  (close-on-throw, observed via a mocked `open` — NOT unlink, since libuv opens FILE_SHARE_DELETE on win32 so a
  leaked-handle unlink does not throw) / force the in-flight branch back through AssistantMarkdown / drop
  `memo(DocRow)` — each fails its test.
- **Docs.** rag-design.md §2 (markdown fence-awareness + TSV/CSV delimiter notes) + §13.6 (the RAG-N6
  includeArchived parity regression test); security-model.md (SEC-N1 NUL rejection under skill-import defences;
  a new Phase-7 polish section for SEC-N2 benchmark `requireUnlocked` parity + the SEC-N3 accepted Info
  residual); architecture.md renderer-tail note (PERF-5 Part A landed; Part B / FE-5 windowing re-deferred).
  Code comments cite ING-8 for the async I/O conversions.
- **Out of scope (untouched).** No Phase 8 work (no doc-folding into topic-doc §§ / no deleting the audit
  file). No E5 prefix migration, no chunk-size change. `registerRagIpc`/`askDocuments` lock guard NOT added
  (not a named Phase-7 finding). PERF-5 Part B (windowing) deferred.
- **Next action (owner):** review/commit Phase 7 (do NOT auto-push/merge). Then **Phase 8 — docs
  reconciliation + audit close-out** (fold finished records into topic-doc §§, delete the audit file)._


_2026-06-28 — **Full audit 2026-06-28 remediation — Phase 6 (RERANKER SCORING DEPTH, retrieval quality;
RAG-N3 Med + DOC-N6 Low, with the dependency TEST-N4 Med folded in) — the load-bearing reranker
(rag-design §12.3) scored only the FIRST 320 approx-tokens of each 500-token chunk, so a chunk whose
key sentence lived in its second half was under-scored, could lose its page's dedup slot, or drop out of
the final top-k (branch `full-audit-2026-06-28-fixes`).** Suite **2398 passed / 39 skipped** (was 2395/39
at Phase 5 → **+3 tests**), typecheck clean, build OK. **Reranker-only behavior change** (one constant) +
retrieval tests + the rag-design notes — **NO re-index, no embedding/FTS/chunk-count/schema change, no
ranking-algorithm change**; offline/no-telemetry posture held. Methodology per the audit: the measurable
tests were built FIRST, the RAG-N3 test confirmed FAILING on the 320 cap, THEN a DELIBERATE owner decision,
THEN the fix, THEN the ceiling documented either way.
- **OWNER DECISION — option (a): raise `MAX_DOC_APPROX_TOKENS` to the WHOLE chunk window.** Set
  `MAX_DOC_APPROX_TOKENS = CHUNK_DEFAULTS.chunkSizeTokens` (500), keyed off the chunker's source of truth
  (so a future chunk-size change carries the rerank budget with it), NOT a standalone literal. Chosen over
  (b) shrink chunks toward 320 (BIG blast radius — re-index every corpus, changes granularity/embeddings/
  FTS/chunk counts; its own phase), (c) head+tail (more complex, can miss the middle), (d) keep 320 +
  document only. **Smallest blast radius** (one constant, no re-index, no embedding/FTS impact) and the
  faithful fix (reranker sees every chunk in full).
- **n_ctx is SAFE (concrete).** The constructor already CLAMPS `docApproxTokens = min(MAX_DOC, usable −
  queryCap)`; at the default 2048 ctx `usable = floor(2048/2.2) − 16 = 914`, queryCap 160 ⇒ clamp ceiling
  754 ≥ 500, so the cap lands at exactly 500. Worst-case pair `(160 + 500) × 2.2 ≈ 1452 real tokens` < the
  2048 context AND the 2048 physical batch (the `n_batch=n_ubatch` rerank-mode constraint). The clamp
  guarantees no overflow even at a smaller configured context.
- **Latency — REASONED, not measured (no provisioned drive / real bge-reranker weights in CI/dev; the
  GGUF is never committed).** From §12.3 the OLD worst case was 24.7 s for a 12-candidate batch at full
  320-token docs (~2 s/candidate, CPU-pinned i7-1185G7). Doc budget 320→500 grows per-pair input
  ~480→660 approx tokens (~1.38×); CPU prefill ≈ linear ⇒ absolute worst case ~34 s for 12 full-500-token
  candidates. Typical queries (shorter chunks, fused union usually < 12) scale proportionally less; stays
  opt-in-by-provisioning, CPU-pinned, candidate-cap-bounded. The candidate cap / `MAX_DOC_APPROX_TOKENS`
  remain the levers if latency proves high. The §12.3 "rescued #3→#1" validation was itself measured under
  the OLD 320 truncation — now disclosed in the docs.
- **TEST-N4 (the dependency, folded in) — graded-overlap ranking.** The prior ordering tests all queried
  text BYTE-IDENTICAL to the target chunk (the mock embedder is feature-hashing), so "exact match ranks
  #1" was the only assertion a broken cosine couldn't fail. New CI test (`rag.test.ts`): a query sharing
  4/2/1 tokens with chunks A/B/C (NONE equal to the query, all 6 tokens for comparable norms) asserts the
  FULL order [A,B,C] with STRICT `<` between adjacent fused scores. Mock cosines empirically verified
  strictly monotone (~0.83 > 0.42 > 0.22) before fixing the token set. The assembled rescue test
  (`hybrid-search.test.ts`) now asserts RELATIVE RANK, not membership: a keyword-rescued exact-code chunk
  is lifted to **#1** ahead of a vector-only distractor (RRF rewards the chunk present in both lists;
  `minSimilarity: -1` keeps both as candidates so the rank — not mere presence — is pinned).
- **RAG-N3 behavioral test (the proof) — `reranker.test.ts` [RAG-N3].** Using the fake-server harness, a
  ~404-approx-token doc with a `TAILSENTINEL` past the old 320 budget asserts the WHOLE chunk (incl. its
  tail) reaches the sidecar. **Confirmed FAILING on the 320 cap** (received text stopped at `h319`), passes
  after the fix. The existing truncation test's doc assertion was updated 320 → `CHUNK_DEFAULTS.chunkSizeTokens`.
- **Dedup-winner verification — `rag.test.ts` [RAG-N3].** End-to-end through the REAL `LlamaReranker` (its
  internal truncation runs) wired to a content-scoring fake sidecar: two chunks on the SAME page, the
  lexical favorite (`headMiss`) vs a chunk hiding the answer SENTINEL in its TAIL (`tailHit`). The sidecar
  scores a candidate 10 iff the RECEIVED text contains the sentinel — so `tailHit` can only win the page's
  dedup slot if its tail was sent. Asserts `tailHit` wins (text contains the sentinel, score 10). This
  pins that the dedup-by-page winner now rests on the whole-chunk score.
- **TEETH (neuter → fail → restore).** Reverting the cap to 320 fails BOTH RAG-N3 tests (tail dropped,
  dedup winner flips); restored. Reversing the `rrfFuse` sort fails BOTH TEST-N4 tests (graded order +
  rescue rank); restored. The src diff is teeth-leftover-clean.
- **Docs (DOC-N6) — `docs/rag-design.md`.** New "Known retrieval-quality ceilings" note in §11 stating
  (1) E5 runs PREFIX-LESS → compressed cosines (R3) → WHY the reranker is load-bearing, with the
  `query:`/`passage:` prefix migration recorded as a **tracked TODO** (re-embeds the whole corpus — its own
  phase; would re-enable a meaningful `ragMinSimilarity` floor); (2) the reranker scores the leading N
  approx-tokens, N raised 320 → 500 (whole chunk) by RAG-N3, with the clamp caveat. §11 reranker para, §12.2
  D10, §12.3 (worst-case budget + the "measured under 320" disclosure + the reasoned ~34 s), and §12.4
  (combined 1056 → 1452 real tokens) updated accordingly.
- **Files changed:** `apps/desktop/src/main/services/reranker/llama.ts` (the cap + its rationale comments);
  tests `tests/integration/{reranker,rag,hybrid-search}.test.ts`; `docs/rag-design.md`. **Out of scope
  (untouched):** `chunker.ts` (option b not chosen — no chunk-size change), `rag/index.ts` (the dedup/ordering
  algorithm is unchanged; only its score BASIS improved — verified by the fixture), the E5 prefix migration
  (recorded as a TODO only), embedder/FTS/schema, all other audit phases.
- **Don't-regress confirmed:** RRF determinism + the pass-through guarantee (no keyword/no reranker ⇒
  byte-identical to vector-only) and the reranker index→result mapping contract stayed green; the n_batch
  headroom holds (1452 < 2048).
- **Next action (owner):** review/commit Phase 6 (do NOT auto-push/merge). Then **Phase 7 — ingestion edge
  cases + small security/test/perf polish** (RAG-N4 markdown fences, RAG-N5 TSV delimiter, RAG-N6 archived,
  SEC-N1/N2/N3, TEST-N5/N7/N8, PERF-1/2 async I/O, PERF-5/6 render) per `audits/full-audit-2026-06-28.md` §6._


_2026-06-28 — **Full audit 2026-06-28 remediation — Phase 5 (DATA-LAYER HARDENING; REL-4 Med, REL-5 Low,
PERF-3 Med, PERF-4 Low, DATA-1/DATA-2/DATA-3 Low) — atomicity + two additive indexes + an FTS trigger
guard + two pinned invariants, all additive (no schema-shape change; indexes `IF NOT EXISTS`, one FTS
trigger drop/recreate the only non-index DDL).** Suite **2395 passed / 39 skipped** (was 2381/39 at Phase 4
→ **+14 tests**), typecheck clean, build OK. Touched ONLY `db.ts`, `chat.ts`, `vision/history.ts`, their
tests + a new `data-layer-hardening.test.ts`, and the architecture data-layer notes — no schema shape,
FK, retrieval/ranking, business-logic, or renderer change; offline/no-telemetry posture held.
- **REL-4 (`deleteConversation` atomic).** Its two auto-committed deletes (messages, then conversations —
  no `ON DELETE CASCADE`) are now ONE `BEGIN…COMMIT` with `ROLLBACK` on throw (mirrors `deleteDocument`),
  so a crash/`SQLITE_BUSY` between them can't leave an orphaned empty thread (compaction checkpoint rows
  live in `messages` too).
- **REL-5 (`deleteImageSession` reordered).** Deletes the ROW first (in a txn), shreds the stored image
  only AFTER — the DATA-1 ordering — closing the "file shredded before a failed delete → undeletable ghost
  session" window.
- **PERF-3 (`idx_messages_conv_kind`).** `getLatestCheckpoint` runs every chat/grounded turn
  (`conversation_id AND kind='compaction' ORDER BY rowid DESC LIMIT 1`); the new composite serves it with
  no SCAN/temp-B-tree (EXPLAIN-pinned). **Correction to the audit's literal recommendation:** it specified
  `(conversation_id, kind, rowid)`, but SQLite **rejects** naming rowid in an index ("no such column:
  rowid") since `messages` has a TEXT PK + implicit rowid — verified empirically. `(conversation_id, kind)`
  gives the identical plan because SQLite auto-appends the rowid. `idx_messages_conversation` is RETAINED
  (still serves `listConversationTurns` / the summary-marker lookup; the composite can't, because their
  `rowid>?` range + `ORDER BY rowid` is blocked by the non-equality `kind!='compaction'` — review-confirmed,
  comment corrected).
- **PERF-4 (`idx_summary_cache_created`).** Summary-cache eviction (`ORDER BY created_at ASC`) was a
  full-scan + temp-B-tree sort; the index makes it an ordered index scan (EXPLAIN-pinned; residual partial
  sort only the `content_hash` tiebreak).
- **DATA-1 (`messages_fts_au` kind guard + backfill).** The UPDATE trigger now guards its INSERT with
  `WHERE new.kind IS NOT 'compaction'` (DELETE stays unconditional → a plain→compaction edit still purges
  the stale FTS row); `ensureMessagesFtsUpdateKindFilter` drop/recreates the trigger on pre-fix DBs
  (mirrors `ensureMessagesFtsKindFilter`). A future in-place edit of a checkpoint row can't leak its
  summary into conversation search — old or new drives.
- **DATA-2 (invariant test, no code change).** `tree_edges.child_id` is a polymorphic FK with no FK to
  chunks; the no-dangling-edge invariant holds because every chunk-delete path tears down `tree_nodes`
  (cascading edges). Pinned: after `deleteDocument`, zero `child_is_chunk=1` edges reference a gone chunk;
  the forbidden chunks-only delete dangles them (teeth).
- **DATA-3 (idempotency confirmed, no code change).** `extract.ts` is idempotent per chunk (main loop skips
  a matching-hash `__scan__` marker; `commitChunk` deletes-then-inserts). Pinned: re-extract — incl. a
  forced re-commit via a changed chunk hash — never doubles the marker count.
- **Tests (+14) + teeth.** New `data-layer-hardening.test.ts` (REL-4 rollback-on-injected-failure +
  illustration; PERF-3 EXPLAIN + drop-index teeth + the rowid-rejection assertion; DATA-2 invariant +
  forbidden-path teeth). `image-history.test.ts` (REL-5 failed-delete-leaves-file-intact).
  `conversation-search.test.ts` (DATA-1 fresh-DB no-leak + pre-fix-DB backfill). `whole-doc-extract.test.ts`
  (DATA-3 no-double). `summary-cache-eviction.test.ts` (PERF-4 EXPLAIN + teeth). **Teeth-verified** by
  neutering each behavioral fix and watching its test fail, then restoring: REL-4 (half-delete), REL-5
  (file shredded first), DATA-1 fresh + backfill (compaction text leaks), DATA-3 (marker doubles). The
  PERF-3/PERF-4/DATA-2 tests carry inline drop-index / forbidden-path teeth.
- **Adversarial review pass (5-dimension multi-agent workflow + per-finding verify).** Migration-safety,
  transaction-correctness (incl. nested-BEGIN), and scope/regression returned ZERO findings. Three confirmed
  LOW/nit comment-accuracy + test-label items, all fixed: (a) the PERF-3 comment over-claimed the composite
  "serves" the listing/marker queries (the planner keeps `idx_messages_conversation`; could mislead a
  maintainer into dropping it) → corrected; (b) PERF-4 "index range scan" → "ordered index scan
  (LIMIT-bounded)"; (c) the REL-4 "TEETH" test never called `deleteConversation` (the real guard is the
  injection test) → relabelled as an illustration.
- **Files changed:** `apps/desktop/src/main/services/db.ts` (2 indexes, `messages_fts_au` guard +
  `ensureMessagesFtsUpdateKindFilter` backfill), `chat.ts` (`deleteConversation` txn), `vision/history.ts`
  (`deleteImageSession` reorder); tests `tests/integration/{data-layer-hardening(NEW),image-history,
  conversation-search,whole-doc-extract}.test.ts`, `tests/unit/summary-cache-eviction.test.ts`;
  `docs/architecture.md` (data-layer index inventory + Phase 5 hardening record). **Out of scope
  (untouched):** `summary-cache.ts` / `extract.ts` code (DATA-3/PERF-4 are index/test-only), retrieval/
  ranking (RAG-N3 — Phase 6), business logic, renderer.
- **Next action (owner):** review/commit Phase 5 (do NOT auto-push/merge). Then **Phase 6 — reranker scoring
  depth (RAG-N3 + DOC-N6)**, which per the audit §6/§7 should land AFTER the retrieval-order test **TEST-N4**
  exists (graded-overlap ranking), so the quality change is measurable._


_2026-06-28 — **Full audit 2026-06-28 remediation — Phase 4 (CJK/THAI TOKEN-vs-WORD wave; RAG-N1
Medium + RAG-N2 Low) — the prior backend audit made the EMBEDDER/RERANKER token-aware (counting
approx-TOKENS, not whitespace words); the SAME confusion still lived UPSTREAM in two ingestion spots,
fixed here as one root-cause wave (branch `full-audit-2026-06-28-fixes`).** Suite **2381 passed / 39
skipped** (was 2374/39 at Phase 3 → **+7 tests**), typecheck clean, build OK. **Ingestion-only**
(audio parser + chunker) — no IPC surface, schema, embedder/reranker, or retrieval/fusion change;
offline/no-telemetry posture held. Touched only `parsers/audio.ts`, `chunker.ts`, their tests, and the
rag-design / architecture / wave-3-plan doc notes (no `index.ts` change was needed — the reconstruction
path is unchanged).
- **RAG-N1 (audio packing counted WORDS → CJK/Thai overflow).** `packTranscriptSegments` capped a
  packed segment at `AUDIO_SEGMENT_MAX_WORDS = 400` via `text.split(/\s+/).length`. For a space-less
  script a 1,200-char phrase is a few "words" but ~1,200 approx-tokens, so a packed segment blew past
  the 500-token chunk window → the chunker WINDOWED it with 80-token overlap → the
  one-segment-per-chunk/no-overlap invariant broke → `audioSegmentsFromChunks` emitted DUPLICATED text
  at every overlap boundary in the preview/translate/compare output (retrieval was unaffected — overlap
  is benign there). **Fix:** measure with `approxTokenCount` (the CJK/Thai-aware counter the chunker
  budgets with); cap on tokens; split an over-budget single whisper segment via
  `windowByTokens(text, MAX, 0)` (CHARACTER boundaries for space-less scripts, overlap 0 = lossless
  partition), not a whitespace split.
- **RAG-N2 (chunker overlap DROPPED for space-less scripts).** `atomize` hard-cut a space-less run into
  char atoms of `cap` (500) tokens; `windowByTokens`'s step-back only re-includes a whole atom ≤ `ov`
  (80), so a 500-token atom was never stepped back into → consecutive CJK/Thai chunks had **zero**
  overlap (a boundary-straddling fact could be missed; Latin was fine). **Fix:** char-slice an over-long
  space-less run at `gcd(cap, overlap)` chars (= 20 for 500/80) with a `glued` flag, and reassemble
  glued atoms with NO separating space; the existing whole-atom step-back then re-includes exactly
  `overlap` tokens. `overlap = 0` recovers the prior `cap`-sized slicing exactly.
- **ENGINEERING DECISIONS (made + documented here — no owner sign-off).** (1) **Audio cap value:**
  `AUDIO_SEGMENT_MAX_TOKENS = CHUNK_DEFAULTS.chunkSizeTokens − 100 = 400` (a 20 % margin below the 500
  window), keyed off the chunk-window constant rather than a standalone literal; `AUDIO_SEGMENT_TARGET_TOKENS
  = 180`. (2) **RAG-N2 approach:** `gcd(cap, overlap)`-sized glued char-slices (chosen over cut-at-`cap−overlap`,
  which still can't be stepped back into) — it reuses the existing step-back unchanged, fills windows to
  exactly `cap`, overlaps by exactly `overlap`, and is byte-identical at `overlap = 0`.
- **THE INTERACTION GUARANTEE (verified).** RAG-N2 ADDS overlap to char-sliced TEXT chunks; RAG-N1 needs
  AUDIO to stay NO-overlap. Compatible because every packed audio segment is guaranteed
  `approxTokenCount ≤ 400 < 500`, so the chunker emits exactly ONE window per audio segment (it never
  char-cuts or overlaps audio — the char-slice/overlap path is never reached). Proven: a long CJK AUDIO
  transcript round-trips through `audioSegmentsFromChunks` with **no duplicated spans**, while a long CJK
  TEXT document now gains overlap, and Latin prose is byte-identical. (`approxTokenCount` is additive
  across a single-space join of trimmed parts, so the packer's running token total equals what the
  chunker measures — the cap holds exactly.)
- **One documented nuance (benign, no dup).** A single over-budget whisper segment is split into pieces
  that SHARE one time-range label, so the chunker's `coalesceSegments` re-merges them and a small trailing
  remainder can normalize a `\n\n` boundary to a SINGLE space in a space-less script. Empirically verified
  across token counts: reconstruction is always byte-identical **up to whitespace** — never a duplicated
  or dropped span. Pre-existing property of coalesce (the old word-based Latin oversize path had it too);
  documented in rag-design §2 + the audio.ts note rather than papered over.
- **Tests (+7) + teeth.** chunker: CJK consecutive-window overlap ≈ `overlap`; space-less lossless partition
  at overlap 0; an over-long no-space LATIN run (base64/URL) is glued (NO injected spaces) and gains overlap.
  audio: JA + Thai oversize single segment char-split ≤ MAX; JA + Thai transcripts pack to one-window
  segments (1:1 chunks); oversize single CJK segment round-trips with no dup/loss (n = 800/900/1250, covering
  the remainder-merge case). integration: a long Japanese transcript round-trips through chunk storage with
  each unique marker exactly once (no dup). **Teeth-verified** by neutering each fix and watching its test
  fail, then restoring: RAG-N2 gcd-slice (CJK overlap test failed), RAG-N1 token cap (round-trip + one-window
  tests failed with markers duplicated).
- **Latin "don't-regress" — precise.** Ordinary space-separated prose is byte-identical (words ≤ `size` are
  never sliced — pinned by the unchanged Latin window/overlap tests). The ONLY Latin change is for an
  over-long NO-SPACE run (> ~2000 chars: base64/URL/glued-PDF) — it is now treated as the space-less run it
  is (glued + overlapped), which also **fixes a latent bug**: the old char-slice path space-joined those
  pieces, injecting spaces into the run and breaking lossless reconstruction. And audio packing's word→token
  switch shifts a boundary only for a rare > 16-char word (the more-accurate measure). Both are intended and
  documented, not regressions.
- **Adversarial review pass (6-dimension multi-agent workflow + per-finding verify).** Surfaced and fixed:
  (a) stale word-based audio descriptions in `architecture.md` and `functionality-wave-3-plan.md` that
  contradicted the token-based code (doc-drift); (b) my oversize round-trip test had cherry-picked n = 800
  (exact 2×400, no remainder) → broadened to n = 800/900/1250 asserting the precise no-dup/no-loss guarantee;
  (c) over-claimed "LOSSLESSLY" wording → scoped to "no duplicated/dropped spans" with the whitespace-nuance
  documented; (d) a latent gcd-coprime slice-size footgun noted (not reachable — all callers use overlap 0 or
  80). The review's "Latin not byte-identical" findings were correctly dismissed by the verify agents as the
  intended, documented over-long-no-space-run fix.
- **Re-index self-heal (owner note).** These are NEW-ingestion changes: existing audio/CJK documents keep
  their old chunks until a document/audio is re-indexed (re-index re-transcribes/re-chunks and self-heals).
  No migration needed.
- **Files changed:** `apps/desktop/src/main/services/ingestion/parsers/audio.ts` (token-based packing,
  char-split), `chunker.ts` (gcd glued char-slice overlap + `assembleAtoms` + `gcd`); tests
  `tests/unit/{chunker,audio-parser}.test.ts`, `tests/integration/audio-ingestion.test.ts`;
  `docs/rag-design.md` (§2 audio row + "Audio packing" note, §3 windowing), `docs/architecture.md` (audio
  packing record), `docs/functionality-wave-3-plan.md` (audio framing); `BUILD_STATE.md`. **Out of scope
  (untouched):** embedder/reranker token logic (already CJK-aware), retrieval/fusion, schema, MAX_CHUNKS
  reject path, RAG-N3 (reranker depth — Phase 6).
- **Next action (owner):** review/commit Phase 4 (do NOT auto-push/merge). Then **Phase 5 — data-layer
  hardening (REL-4, REL-5, PERF-3, PERF-4, DATA-1, DATA-2, DATA-3)** per `audits/full-audit-2026-06-28.md` §6._


_2026-06-28 — **Full audit 2026-06-28 remediation — Phase 3 (RENDERER ROBUSTNESS; FE-1 High +
FE-2…FE-9) — the renderer was the least-audited surface (prior rounds were backend-only); the headline
gap was that ANY screen render throw blanked the whole offline app with no recovery (branch
`full-audit-2026-06-28-fixes`).** Suite **2374 passed / 39 skipped** (was 2356/39 at Phase 2 → **+18
tests**), typecheck clean, build OK. **Renderer-only** (plus the shared i18n catalogs) — no IPC surface,
no main-process behavior, no data-layer change; offline/no-telemetry posture held. Touched only the
listed renderer files + their tests + the architecture renderer record.
- **THE FIX (FE-1, verified High) — top-level React error boundary.** Before: zero
  `ErrorBoundary`/`componentDidCatch`/`getDerivedStateFromError` anywhere, so a screen render throw
  (`react-markdown` on malformed model output, a Radix portal edge) unmounted the whole tree → blank
  window, force-quit. Now: new `renderer/components/ErrorBoundary.tsx` (class component,
  `getDerivedStateFromError` + `componentDidCatch`, `fallback(reset)` render-prop). **LOGGING IS
  LOCAL-ONLY** (`console.error`; no renderer→main log IPC exists — preload has only READ-only
  `getLogTail`/`exportLog`; never a network call — CLAUDE.md hard rule). **Per-screen boundary** in
  `App.tsx` wraps the active screen KEYED by `screen` (navigating away re-mounts → clears the error)
  INSIDE `<main>` so the nav rail stays alive; localized `ScreenErrorFallback` (role="alert") offers
  in-place **Try again** (reset) + **Go to Home**. **Outer last-resort boundary** in `main.tsx` wraps
  `<App/>` (catches the gate/provider/AppShell) with a localized `RootErrorFallback` resolved via the
  pre-unlock language (it sits outside `I18nProvider`).
- **FE-2…FE-9 (the cluster).** FE-2 unhandled IPC rejections — `ModelsScreen` cancel `.catch` →
  `friendlyIpcError`, `SkillsTab.pick()` moved `pickSkillPackage` inside the try → toast. FE-3 skill
  toggle double-submit — per-skill in-flight `Set` disables the Switch while pending + ignores stale
  submits; `refresh()` reconciles to server state. FE-4 setState-after-unmount — the HomeScreen `let
  active` guard / a `mountedRef` applied to the Documents import poll, PrivacyTab, DiagnosticsTab
  refreshers, SkillsTab settings load, General tab. FE-5 — `applyLanguageSetting` is now
  `useCallback([])` (identity-stable) so a UI-language switch no longer re-fires App's
  `getPolicy()`+`getSettings()` effect. FE-6 — ScopePopover pending chips key by `name+index`
  (unique even for two cross-folder files sharing a base name, and content-aware); ChatScreen optimistic
  id uses a monotonic counter (not `Date.now()`). FE-7 — ToastProvider tracks its dismiss
  timers in a ref + clears them on unmount. FE-8 — DiagnosticsTab benchmark failure → `friendlyIpcError`,
  `'UNKNOWN'` literal → `t('diag.app.unknown')`. FE-9 — SegmentedControl Home/End select the first/last
  ENABLED segment directly (`moveToEdge`), not via the arrow-key modulo wrap.
- **New i18n keys (en + de, parity typecheck-enforced):** `errorBoundary.title`, `.body`, `.retry`,
  `.home`, `.app.title`, `.app.body`, `.app.reload`.
- **Tests added (+16) + teeth.** New `ErrorBoundary.test.tsx` (3: children pass-through; throw → local
  log + onError + fallback; reset re-mounts), `AppErrorBoundary.test.tsx` (3: screen throw → localized
  fallback + nav rail alive; nav re-mount clears; **de** fallback render), `DiagnosticsErrors.test.tsx`
  (2: friendly bench error has no transport/Error prefix; profile row shows localized "unknown" not
  'UNKNOWN'), `ScopePopover.test.tsx` (1: name-keyed pending chips). Extended `Components.test.tsx`
  (FE-9 Home/End skip disabled ends; FE-7 timer cancelled on unmount via `vi.getTimerCount()`),
  `SkillsTab.test.tsx` (FE-3 second toggle suppressed + Switch disabled + ends on server state; FE-2
  picker reject → friendly toast), `ModelsScreen.test.tsx` (FE-2 cancel reject → friendly error),
  `I18n.test.tsx` (FE-5 `applyLanguageSetting` referentially stable across a language switch),
  `DocumentsScreen.test.tsx` (FE-4 in-flight poll tick after unmount does NOT refresh the list —
  deferred-promise harness gives it teeth despite React-18's silent no-op).
- **Files changed:** new `renderer/components/ErrorBoundary.tsx` (+ barrel export); `renderer/App.tsx`,
  `renderer/main.tsx`, `renderer/i18n.tsx`, `renderer/components/{Toast,SegmentedControl}.tsx`,
  `renderer/chat/ScopePopover.tsx`, `renderer/screens/{ChatScreen,ModelsScreen,DocumentsScreen,SettingsScreen}.tsx`,
  `renderer/screens/settings/{SkillsTab,PrivacyTab,DiagnosticsTab}.tsx`; `shared/i18n/{en,de}.ts`; the
  9 test files above; `docs/architecture.md` (new "Renderer robustness — design record (full audit
  2026-06-28, Phase 3)" §). **Out of scope (untouched):** main-process (PERF-1/PERF-2 deferred to
  Phase 7), data-layer, RAG, perf items PERF-5/PERF-6.
- **Teeth-verified** by neutering each meaningful fix and watching its test fail, then restoring
  (FE-1 fallback+reset, FE-3, FE-4, FE-5, FE-7, FE-8, FE-9, plus the two review-fix tests below).
- **Adversarial review pass (6-dimension multi-agent workflow + per-finding verify) found 3 real issues,
  all fixed in a follow-up:** (a) the FE-6 pending-chip key (originally name-only) collided on duplicate
  base names → changed to `name+index`; (b) its test had no teeth (a key only affects reconciliation) →
  added a duplicate-name no-warning teeth test; (c) the FE-1 fallback's "Go to Home" was a no-op when
  Home itself threw (same-value navigate, no key change) → `onHome` now `reset()` + `navigate('home')`,
  with a recovery teeth test. The review's other "findings" were the transient teeth-check neuters in the
  working tree (correctly dismissed by the verify agents; committed HEAD was clean).
- **Next action (owner):** review/commit Phase 3 (do NOT auto-push/merge). Then **Phase 4 — CJK/Thai
  token-vs-word wave (RAG-N1, RAG-N2)** per `audits/full-audit-2026-06-28.md` §6._


_2026-06-28 — **Full audit 2026-06-28 remediation — Phase 2 (GPU MID-SESSION CRASH AUTO-FALLBACK,
reliability; REL-1 High + REL-2 Low) — the advertised self-healing CPU fallback was a silent no-op
(branch `full-audit-2026-06-28-fixes`).** Suite **2356 passed / 39 skipped** (was 2353/39 at Phase 1 →
**+3 tests**), typecheck clean, build OK. Runtime-lifecycle only — **no IPC surface, GPU probe/ladder
selection, or settings-schema change**; offline/no-telemetry posture held. Touched only the runtime
files + their tests + the architecture §5.3 record. Methodology: the crux **integration test FIRST**
(driven through the REAL `RuntimeManager` + `createSelectingRuntimeFactory` + `createGpuCrashAutoFallback`
with a fake child at the spawn seam, **no fake `restart`**), confirmed FAILING against the pre-fix
wiring, THEN the fix, THEN green; both behavioral fixes teeth-verified by neutering them.
- **THE BUG (REL-1, verified High).** When a GPU-backed `llama-server` dies mid-session, the crash hook
  called `restart(opts) = runtimeRef.start(opts)` with the SAME `modelId`. But the crashed `LadderRuntime`
  is still `RuntimeManager.current` (the manager never observes the child exit; it caches `this.last` at
  start and never re-polls), so `start()` hit its same-model **idempotency guard** (`runtime/index.ts`) and
  early-returned a stale status read — it NEVER stopped-and-restarted. Net: `gpuAutoDisabled` got persisted
  and the friendly "compatibility mode" notice showed, but no restart happened; `status()` kept reporting
  the **dead** server as running/healthy; the next chat/RAG/doctask turn routed to it and failed (user had
  to manually Stop/Start). The tests missed it because `runtime-ladder.test.ts` injects a FAKE `restart`
  (real manager never exercised) and `runtime-manager.test.ts` proves the guard in isolation — nothing
  wired the real crash path THROUGH the real manager.
- **ENGINEERING DECISION — option (b): a crash-only `RuntimeManager.forceRestart(opts)`.** Inside ONE
  enqueued op it does `doStop()` (clears `current`/`last` → `status()` immediately stops reporting the dead
  server healthy) then `doStart(opts)`, bypassing **only** the same-model guard. Chosen over (a) wiring-level
  `stop()`-then-`start()` — its two ops enqueue separately, so a concurrent user start could interleave —
  and (c) manager-subscribes-to-unexpected-exit (more plumbing, no extra guarantee). `forceRestart` is
  atomic within the op-queue, explicit, and easiest to test. **Normal `start()` idempotency is PRESERVED**
  (a double-click / AI-Model-screen revisit still no-ops — the existing idempotency tests stay green); only
  the crash path bypasses it. `forceRestart` sets `startingModelId` synchronously (exactly as `start()`), so
  a concurrent manual `start(sameModel)` JOINS the restart instead of queueing a second one. Wiring:
  `main/index.ts` crash `restart` now calls `runtimeRef.forceRestart`, not `start`.
- **Retry bound (no loop):** `gpuAutoDisabled` is persisted BEFORE the restart, so the ladder rebuilt inside
  `doStart` skips rung 1 → CPU (`--device none`); a later CPU crash does NOT route through `onGpuCrash`
  (`LadderRuntime` gates it on `backend === 'gpu'`), so a GPU session auto-falls-back **at most once**. A
  dedicated "does NOT loop" test pins this (CPU crash after the fallback triggers no second restart).
- **THE CRUX TEST (`tests/integration/runtime-manager.test.ts`).** Real manager + real factory + real crash
  fallback; fake `FakeServerChild` at the `spawn` seam and a loopback `fetch` that **refuses a dead child's
  port** (so a chat routed to the crashed runtime genuinely fails — that gives the post-crash chat assertion
  its teeth). Flow: (1) start a GPU runtime → `backend:'gpu'`, healthy; (2) emit an unexpected child `exit`;
  (3) assert exactly **one stop + one start** (one new spawn — not zero=swallowed, not a loop; dead runtime
  stopped once; restarted one still live), the new backend is **cpu** (`--device none` on the 2nd spawn),
  `gpuAutoDisabled` persisted, the compatibility notice fired, and `status().{backend,healthy,port}` reflect
  the **NEW** server (port ≠ the dead one); (4) a chat turn after the crash streams `'hello'` from the
  restarted CPU server. **Teeth:** with the pre-fix wiring (`restart → start`) the test FAILS at "expected
  `children` length 2, got 1" (restart swallowed); with `forceRestart` it passes.
- **REL-2 (Low, bundled — same `sidecar.ts`).** `LlamaServer.start()` guarded only on `if (this.child)`,
  but `this.child` is assigned AFTER `await verifyBinary` + `await findPort`, so two overlapping direct
  `start()` calls both spawned (the 2nd orphaning the 1st — port + RAM, never stopped). Not reachable in
  prod today (every composer wraps it in its own latch) but latent. Fix: an instance
  `private starting: Promise<void> | null` returned when set (mirrors `e5.ts`/`reranker/llama.ts`/
  `vision/runtime.ts`); a second caller now shares the one start AND waits for HEALTH, not just the child
  handle. Unit test: two concurrent `start()` → exactly one spawn (teeth: pre-fix spawns 2).
- **Files changed:** `services/runtime/index.ts` (forceRestart), `main/index.ts` (crash wiring →
  forceRestart), `services/runtime/sidecar.ts` (single-flight latch); `tests/integration/runtime-manager.test.ts`
  (REL-1 integration + no-loop + REL-2 unit tests); `docs/architecture.md` (GPU record §5.3 corrected + a new
  explicit "§5.3 Mid-session crash auto-fallback" subsection documenting the idempotency interaction, the
  chosen fix, and the retry bound); `BUILD_STATE.md`. **Out of scope (untouched):** the GPU probe/ladder
  selection logic, the IPC surface, the settings schema — and no other audit phase.
- **Next action (owner):** review/commit Phase 2 (do NOT auto-push/merge). Then **Phase 3 — renderer
  robustness (FE-1…FE-9: top-level React error boundary + unhandled-rejection / lifecycle fixes)** per
  `audits/full-audit-2026-06-28.md` §6._


_2026-06-28 — **Full audit 2026-06-28 remediation — Phase 1 (FINANCIAL CORRECTNESS; BL-N1…N6 + the
TEST-N2/N6 test gaps) — the highest user-impact bug cluster: the bank/invoice/redaction tools silently
lost or mis-stated money/dates/PII (branch `full-audit-2026-06-28-fixes`).** Suite **2353 passed / 39
skipped** (was 2335/39 at Phase 0 → **+18 tests**), typecheck clean, build OK. Parsing/aggregation only —
**no schema, IPC, trust-model, or audit-payload change**; figures/redacted text stay content-class (never
logged/audited/exported). Offline/no-telemetry posture held. Touched only the four tool files + their
tests + the two listed docs. Methodology: **characterization tests FIRST** (corrected-behavior tests driven
through the REAL entry points — `extractTransactionRows`/`extractStatementBalances`/`reconcileBalances`/
`parseLineItem`/the redaction tool — confirmed failing against the unmodified code, closing the TEST-N2
"pre-isolated token" gap), THEN the code, THEN green; every behavioral fix teeth-verified by neutering it
and watching its test fail.
- **TWO OWNER DECISIONS (resolved via AskUserQuestion before implementing):**
  - **DECISION 1 (BL-N1) — ambiguous/US-ordered dates: _per-document locale inference_.** de-AT day-first
    stays the DEFAULT; the whole document flips to month-first only when it has an unambiguously US-ordered
    date (a `nn/nn/yyyy` whose **second** field is 13–31) and no unambiguously EU-ordered one. A
    fully-ambiguous / self-contradictory doc keeps day-first. **NB the audit's BL-N1 prose stated the
    trigger with the fields swapped** ("first field >12 → mm/dd"), which is inverted — a first field >12 can
    only be a day, forcing day-first; the mechanically-correct rule shipped and is recorded in
    architecture.md §10 so it is not re-litigated. (Option b/c's result-attached caveat was out of scope —
    the tool output schema is frozen.)
  - **DECISION 2 (TEST-N2) — grouped figures: _full support_.** Bare `1.000`/`2.500` → 1000/2500 (de-AT dot
    = thousands), space-grouped `1 234 567,89` → 1234567.89, Swiss apostrophe `1'234.56` → 1234.56.
- **Per-finding (before → after, verified reproductions):**
  - **BL-N1** `parseDate('12/31/2026')` → null → **whole row silently DROPPED**; `'03/05/2026'` → 3 May
    (wrong). Now a US-ordered statement infers mm/dd: `12/31` parses (not dropped), `03/05` → 5 Mar; an EU
    statement keeps day-first. `inferDateOrder` threaded through bank + invoice extractors. **Redaction does
    NOT infer** (stays day-first — BL-N6).
  - **BL-N2** `Endsaldo 1.234,56 EUR per 30.06.2026` → closing read the trailing date `30.06.20` → **3006.20**
    (flipping the completeness gate). New `stripDateTokens` scrubs date tokens before the last-money
    balance/total scan (`lastMoneyOnLine`, invoice `lastMoney`); date at EITHER end handled, so the de-AT
    date-first `Kontostand per <date> <figure>` shape is unaffected. **This disproved the §24/§10 BL-1
    "last-token readers were never affected" claim — corrected in both places.**
  - **BL-N3** `Betrag 100,00 EUR -100,00 900,00` → amount = first token = **100** (value AND sign wrong).
    `parseLine` now takes the second-to-last figure as the amount and the last as the balance when a balance
    is present (byte-identical on a normal 2-figure row).
  - **TEST-N2/DECISION 2** `Grocery 1.000` → **€1** (1000×); `1 234 567,89` → 567.89; `1'234.56` → 234.56.
    `MONEY_RE` rewritten to three ordered alternatives (space / decimal / bare-thousands) with a trailing
    `(?!\d)` + leading `(?<!\d)` anchor + a `(?<![A-Za-z0-9])` boundary on the space form; `parseAmount`
    unchanged. Stays bounded/ReDoS-safe.
  - **BL-N5** `reconcileBalances` now compares in integer cents (`Math.round(x*100)`), identical to
    `assessCompleteness` (C-3). Consistency/defensive — no realistic 2-dp input distinguishes the two (its
    test is a regression guard; teeth are structural).
  - **BL-N4** redaction now masks punctuated US/national phones (`555-123-4567`, `1-800-555-1234`) and a
    lowercase compact IBAN (`de89…`, case-insensitive); both conservative (punctuation required; standalone
    token + per-country length re-validated).
  - **BL-N6** redaction masks every `parseDate`-valid date and does NOT infer locale, so a US `12/31/2026`
    leaks while EU `31/12/2026` masks — DOCUMENTED (lowest priority, kept best-effort, no leak path to any
    log/audit). TEST-N6 pins this + names/addresses-not-masked as accepted limitations.
- **Geometry regression caught + fixed mid-phase:** the first full-suite run flagged
  `pdf-bank-layout.test.ts` (a continuation line `…778899 300,00` fused to **899300** via the new
  space-group form). Fixed with the leading `(?<!\d)` anchor; pinned by a new unit test. The
  **adversarial multi-lens review** (4 agents) then surfaced the *letter*-preceded variant
  (`Ref123 456,78` → 123456.78), fixed with the `(?<![A-Za-z0-9])` boundary + a second unit test. The
  review's other findings were triaged: the "stripDateTokens broken" critical was a **false alarm** (an
  agent read the file during a transient teeth-check neuter — the code is correct); the IBAN glued-prose
  case needs separator-less glue that real extracted text never has (validation-guarded, documented); the
  US-date redaction leak IS BL-N6 (kept documented per the owner's "don't over-engineer" scoping).
- **Docs (ritual):** known-limitations.md — extended the redaction BL-4 bullet (BL-N6 asymmetry +
  phone/IBAN coverage + the IBAN residual) and added a new "bank/invoice LINE PARSER assumptions" bullet
  (date-locale inference residual, amount-column-by-position, grouping trade-offs). architecture.md §10 —
  corrected the BL-1 immunity claim and added the full-audit-2026-06-28 Phase-1 record with both DECISIONS
  "as built (owner)".
- **Files changed:** `tools/money.ts`, `tools/bank-statement.ts`, `tools/invoice.ts`, `tools/redaction.ts`;
  `tests/unit/skills-{bank-statement,invoice,redaction}-tool.test.ts`,
  `tests/integration/skills-analysis-bank.test.ts`; `docs/architecture.md`, `docs/known-limitations.md`,
  `BUILD_STATE.md`.
- **Next action (owner):** review/commit Phase 1 (do NOT auto-push/merge). Then **Phase 2 — GPU crash
  auto-fallback (reliability, REL-1)** per `audits/full-audit-2026-06-28.md` §6._


_2026-06-28 — **Full audit 2026-06-28 remediation — Phase 0 (CI + test-infra safety net; TEST-N1 + TEST-N9)
— FIRST remediation phase, the machine backstop every later phase relies on (branch
`full-audit-2026-06-28-fixes`).** Suite **2335 passed / 39 skipped** (201 files, all collected), typecheck
clean, build OK — both on the existing install AND through a clean `npm ci` with the CI env knobs set.
This phase added CI infra + fixed one test-only side effect: **no application/runtime code changed.**
Offline/no-telemetry posture held — CI is dev infrastructure (a GitHub Actions build pipeline), ships
nothing to users, adds no telemetry/analytics, and performs no network egress beyond the npm registry
install; nothing CI-related is wired into the app.
- **Task A — `.github/workflows/ci.yml` (TEST-N1).** On `pull_request` and `push` to `master`, runs the
  exact pre-release chain `npm ci → npm run typecheck → npm run build → npm test` on a matrix of
  **`ubuntu-latest` + `windows-latest`** (Windows is first-class), Node **22.x** (engines `>=22.5`),
  `actions/setup-node` npm cache keyed off the root lockfile, `concurrency: cancel-in-progress` per ref,
  `fail-fast: false`, top-level `permissions: contents: read` (least privilege — hardened after the
  adversarial review). **Two jobs:** the **`build-and-test`** matrix + a tiny stable **`ci-success`**
  aggregate gate (`needs` the matrix, `if: always()`, fails unless every leg succeeded) — mark
  **`ci-success`** the **required status check** (its name survives OS-label changes; the per-OS leg
  names `build-and-test (ubuntu-latest)` / `(windows-latest)` do not).
- **DECISIONS as built:** (1) **Lockfile** — root `package-lock.json` already exists and is in sync, so
  `npm ci` works as-is; no lockfile generation / no fallback to `npm install` was needed. (2) **Matrix** —
  both OSes from the start (a local Windows dry-run of the full `npm ci` chain passed, so windows-latest
  was NOT deferred). (3) **Trigger scope** — `push` is scoped to `master` (post-merge green + direct
  pushes) while `pull_request` validates every PR against its merge result; this avoids a duplicate CI run
  on every push to a PR branch. Owner can broaden `push` to all branches if desired. (4) **Electron in CI**
  — both `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (skips Electron's own ~100 MB platform-binary download) and
  `HILBERTRAUM_SKIP_ELECTRON_CHECK=1` (short-circuits `scripts/verify-electron.mjs`) are set at workflow
  level. The unit+integration suite is offline by construction (mock runtime + mock embedder, `electron`
  mocked); nothing in typecheck/build/test launches Electron. **Verified locally: a `npm ci` with both vars
  set leaves the Electron platform binary ABSENT (`path.txt` missing) and typecheck + build + test still
  pass 2335/39.** (`ELECTRON_SKIP_BINARY_DOWNLOAD` alone already early-exits verify-electron; the second var
  is explicit + belt-and-suspenders.)
- **Task B — whisper-smoke temp-dir leak (TEST-N9).** `tests/manual/whisper-smoke.test.ts` ran a
  module-scope `mkdtempSync(...)` at collection time on EVERY suite run (even though the `describe` is
  `skipIf`-skipped) and never cleaned it up. Moved it into a `beforeAll` inside the gated `describe` with an
  `afterAll` `rmSync(WORK, {recursive,force})` — placed inside the gated `describe` like
  `dictation-smoke`/`rag-quality`, but ADDING the cleanup those two omit (the adversarial review found
  both leak their own `mkdtemp` dir on an enabled run — recorded as an out-of-scope observation below).
  Swept the other 17 `tests/manual/*` smokes: **whisper-smoke was the only import-time side effect** (the
  rest do their `mkdtempSync`/`writeFileSync` inside test bodies/functions). **Verified: a full suite run
  leaves zero `whisper-smoke-*` dirs in the OS temp dir.**
- **Verification (all green):** (a) post-edit `typecheck`+`build`+`test` = 2335/39, exit 0. (b) Full
  `npm ci` (env vars set) + chain = 2335/39, exit 0, binary absent (above). (c) **FullSuiteGuard teeth
  proven** — temporarily added `exclude: ['tests/unit/smoke.test.ts']` to `vitest.config.ts`; the full run
  reported **200 of 201** files and, although all 2333 collected tests PASSED, `tests/full-suite-guard.ts`
  threw `Full-suite collection guard FAILED … 1 were dropped` and the run **exited 1** (false-green caught);
  reverted → green again. (NB a *rename* would NOT prove teeth — the disk-walk `listTestFiles` drops the
  file from `expected` too, so only a config `exclude` exercises the guard.) (d) `ci.yml` parsed/validated
  with the `yaml` package (`actionlint` not installed locally). **Not yet proven: the workflow turning GREEN
  on GitHub** — that requires the owner to push the branch / open a PR (see Next action).
- **Docs.** New `## Continuous integration (CI)` section in `docs/packaging.md` (placed before the manual
  pre-ship checklist): what CI gates, the two Electron skip knobs, and an explicit statement that the
  `HILBERTRAUM_*` manual harness matrix (audit M-A5) remains a **SEPARATE human pre-release gate CI does NOT
  cover**. CI is the automated floor; the manual matrix + pre-ship checklist stay required and human-run.
- **Files changed:** `.github/workflows/ci.yml` (new), `apps/desktop/tests/manual/whisper-smoke.test.ts`,
  `docs/packaging.md`, `BUILD_STATE.md`. No `package.json`/lockfile change was required.
- **Observed (OUT of Phase 0 scope — flagged for the owner / a later MAINT phase):** the committed root
  `package-lock.json` carries STALE metadata — root `version 0.1.27` / `license Apache-2.0` vs
  `package.json`'s `0.1.34` / `GPL-3.0-or-later` (a plain `npm install` resyncs it). `npm ci` tolerates this
  (only the dependency tree must match the manifest — verified green), so it is NOT a CI blocker; left
  unchanged here because lockfile edits are out of scope unless needed for `npm ci`. **Also (test-infra
  tidy, later phase):** `tests/manual/dictation-smoke.test.ts` and `rag-quality.test.ts` create an
  `mkdtemp` dir in a test body and never `rmSync` it — they leak ONE dir each, but only when ENABLED (the
  human pre-release gate), never at collection time and never in CI, so they are NOT the TEST-N9 class
  (whisper-smoke's import-time leak) and were left for a later cleanup.
- **Next action (owner):** push `full-audit-2026-06-28-fixes` / open a PR so the `build-and-test` checks run
  on GitHub, confirm both OS legs go green, then mark **`ci-success`** a **required status check** on
  `master` (branch protection). Then **Phase 1 — financial correctness** (BL-N1/2/3/4/5/6 + TEST-N2/N6;
  characterization tests first). Do NOT auto-push/merge — owner merges._


_2026-06-28 — **Backend audit 2026-06-27 — FULLY REMEDIATED (all 8 phases) + Phase 9 close-out
(branch `backend-audit-2026-06-27-fixes`).** The multi-persona backend audit (2 High · 9 Medium · 14 Low ·
8 Info; no Critical, no remote-exploitable issue) is closed out. Suite **2335 passed / 39 skipped**,
typecheck clean, build OK — the cumulative branch state is green (no phase regressed another). Offline/
no-telemetry posture held end-to-end; this close-out phase edited **docs + BUILD_STATE only** and removed
the plan file — **no application-code change**.
- **As-built headline picks (per phase):** **P1 (DATA-1/DOC-1/MAINT-1)** atomic-txn `deleteDocument` —
  ordered `purgeDocumentDerivatives` → `purgeSkillDataForDocument` before the row delete, shred-after-commit,
  full-chain `ON DELETE CASCADE` on fresh schemas. **P2 (BL-1/2/3)** shared `money.ts splitLeadingDates`
  value-date strip; single-currency precondition on completeness/reconcile; `(category, currency)`-keyed
  totals. **P3 (REL-1/2/3/6)** `AbortSignal` + per-op timeouts for audio/OCR/dictation; `workDir` required.
  **P4 (REL-5/9/10, BL-5, MAINT-4)** single `parseWithLimits` decorator (preview now capped); symlink-cycle
  guard; single-pass y-fold; ragged-CSV cells kept. **P5 (RAG-1/EMB-1/DATA-2/EMB-4)** coverage-wording honesty
  gate; shared CJK/Thai-aware reranker truncation; `decodeVector` truncated-blob guard; LE-endianness assert.
  **P6 (SEC-1/API-3/DOC-5)** Tier-2 tools gated to **app skills** (`skillCanRunTools` = `source === 'app'`).
  **P7 (SEC-2/3/4/5/6, REL-4/7/8)** permission-check + redirect guards; vision/OCR byte caps; spawn lifecycle;
  SEC-4/5 accepted residuals. **P8 (API-1, DATA-3/MAINT-3, DATA-4, DOC-2/3/4, BL-4, API-2)** chat
  `requireUnlocked()`; `summary_cache` row-count eviction (50 000); doc-drift fixes; API-2 accepted residual.
- **Close-out (Phase 9, as built):** the per-finding **ledger** is folded into [`docs/architecture.md`](docs/architecture.md)
  **§24 "Backend audit (2026-06-27) — remediation close-out"** (mirrors the §23 Skills & Tools precedent) —
  every finding ID → phase → disposition → the topic-doc § its record now lives in, including the docs-only
  and accepted-residual items (SEC-4/SEC-5/API-2 residuals; SEC-7 verified-clean; **TEST-9 not remediated** —
  accepted installer-fixture gap). §24 also carries the **verified-clean inventory** (crypto/vault, zip
  importer, manifest, spawns, offline guard, audit/log, data layer, IPC surface, CLAUDE.md hard-rule
  re-attestation) so the next round does not re-investigate it.
- **Plan file + audit report both deleted** per the CLAUDE.md doc-lifecycle rule —
  `docs/backend-audit-2026-06-27-remediation-plan.md` (a working paper) and
  `audits/backend-audit-2026-06-27.md` (the findings deliverable). Their lasting content now lives in the
  topic-doc §§ (folded by each phase) + the §24 ledger + the §24 verified-clean inventory; both files stay
  **recoverable in git history** (the plan at the parent of the Phase-9 close-out commit; the report at the
  parent of the follow-up fold-in commit). The `audits/` folder is left empty (untracked by git).
- **Next action:** branch is committed and ready — **merge `backend-audit-2026-06-27-fixes` to `master` when
  the owner is ready** (do not auto-merge/push). No open remediation items; the residuals above are on record._


_2026-06-28 — **Backend audit 2026-06-27 remediation — Phase 8 (API consistency, doc drift & housekeeping;
API-1, DATA-3/MAINT-3, DATA-4, DOC-2/3/4, BL-4, API-2) — LOW/INFO CLEANUP PHASE, no renderer surface, no
schema change, no new capability (branch `backend-audit-2026-06-27-fixes`).** Suite **2335 passed / 39
skipped (+5 tests)**, typecheck clean, build OK. Offline/no-telemetry posture held: the lock message and
the eviction diagnostics counter carry no content; eviction deletes summary_cache ROWS by age/count and
never reads/logs the summary text. **The problems (all Low/Info):** the chat IPC handlers had no
`requireUnlocked()` guard, so a locked-vault chat call reached `ctx.db` and threw the raw English
"Workspace is locked — unlock it first." instead of the friendly localized message every other DB-backed
module uses (API-1); `summary_cache` had no eviction → unbounded growth on a long-lived drive (DATA-3/
MAINT-3); plus doc drift (DOC-2/3/4, BL-4) and a harmless read-shape note (DATA-4).
- **API-1 — `requireUnlocked()` preamble on the chat IPC handlers.** New `requireUnlocked()` in
  `registerChatIpc.ts` (throws `tMain('main.chat.locked')` — new i18n key in `en.ts`/`de.ts`) added to
  EVERY DB-touching handler (create/set/update scope+collection+defaultSkill, list/search/listMessages,
  contextUsage, summary, sendChatMessage, delete, export). The two in-memory-only handlers
  (`stopGeneration`, `getActiveStream`) stay workspace-agnostic by design (mirrors `registerImagesIpc`'s
  `getStatus` note). Matches the docs/collections/doctasks pattern exactly.
- **DATA-3/MAINT-3 — DECISION as built: cheap row-count eviction (NOT document-only).** New
  electron-free `services/analysis/summary-cache.ts`: `evictSummaryCache(db, maxRows?)` deletes the OLDEST
  rows (by `created_at`) past `SUMMARY_CACHE_MAX_ROWS` (**50 000** default; env
  `HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS`) — one COUNT, then a single bounded DELETE only when over cap.
  Called **opportunistically once per tree build** at the end of `buildTree` (amortizes the COUNT over the
  whole build, never per cache row; not inside a transaction). It's a cache → an evicted row only costs a
  future re-summarize. Diagnostics counter `summaryCacheEvictedThisSession()` + one content-free
  `log.info('Summary cache pruned', {evicted, kept, sessionTotal})` line (counts only, local log).
- **DATA-4 — `ORDER BY chunk_index`** added to `documentApproxTokenTotal` (`rag/index.ts`) for read-shape
  parity with `retrieveWholeDocument`. The sum is order-independent → ZERO behaviour change.
- **API-2 — no code change.** `importPreflight` raw-paths remain a documented accepted residual
  (`security-model.md`), confirmed and left as-is.
- **Docs.** `rag-design.md` §3 "Cap" rewritten to describe over-cap **rejection** (`main.ingest.tooManyChunks`,
  reject-before-destructive-replace, M13/C4) instead of the legacy silent truncation (DOC-2).
  `known-limitations.md`: new summary_cache eviction bullet under "Document tasks & summaries" (DOC-4); the
  redaction date-locale asymmetry (US-ordered `mm/dd/yyyy` + 2-digit-year slip through; names/addresses
  never masked — under-detection, no un-mask path) folded into the redaction bullet (BL-4); **DOC-3** — the
  prefix-less-E5 ceiling already had a substantive Phase-21 bullet (NOT folded by Phase 5, which deferred
  it), so the existing "Retrieval quality" bullet was reframed to surface the retrieval-quality CEILING
  explicitly (floor-stays-0 **and** reranker-is-load-bearing) rather than add a near-duplicate. `db.ts`
  summary_cache schema comment updated (eviction now implemented, no longer "future policy").
- **Tests (+5, teeth-verified then restored).** `chat-ipc.test.ts` (+1): a locked-vault call to
  list/send/delete → the friendly `'Workspace is locked. Unlock it to chat.'`, never the raw engine string.
  `summary-cache-eviction.test.ts` (+4, new): past-cap pruned to cap keeping the NEWEST rows + counter
  advances; at/under cap a no-op (recent entry survives); env override honored; default cap generous.
  **Teeth:** neutering `requireUnlocked`→no-op failed the locked-vault test; `evictSummaryCache`→`return 0`
  failed the prune + env-override tests (the under-cap/default tests correctly stayed green); both restored.
  **Collateral:** `chat-compaction-ipc.test.ts` + `conversation-search.test.ts` ctx stubs gained
  `workspace: { isUnlocked: () => true }` (they register chat IPC).
- **Data contracts (new):** `evictSummaryCache(db, maxRows?): number`, `summaryCacheEvictedThisSession():
  number`, `SUMMARY_CACHE_MAX_ROWS` (`analysis/summary-cache.ts`); new i18n key `main.chat.locked`
  (en+de). No IPC/schema-shape change; renderer untouched.
- **Eyeball:** none — a main-side cleanup phase, no UI surface. **Next: Phase 9 — close-out** (fold the
  audit's per-finding dispositions into the relevant topic-doc §, mark the remediation complete in
  BUILD_STATE, delete the plan file per the CLAUDE.md doc-lifecycle rule). All implementation phases (1–8)
  are now ✅._

_2026-06-28 — **Backend audit 2026-06-27 remediation — Phase 7 (Electron + vision/runtime hardening;
SEC-2/3/4/5/6, REL-4/7/8) — HARDENING/LIFECYCLE PHASE (Low cluster), no renderer surface, no schema
change, no new capability (branch `backend-audit-2026-06-27-fixes`).** Suite **2330 passed / 39 skipped
(+11 tests)**, typecheck clean, build OK. All hardening/lifecycle only — nothing new logged/audited;
offline posture held; the permission-check handler does NOT weaken the request handler (they share one
predicate). **The problems (all Low, none exploitable given offline + prod-CSP):** only the async
permission-*request* handler was installed (the synchronous *check* path fell back to Electron's
default-grant — SEC-2); `will-navigate` was guarded but `will-redirect` was not, so a server/`<meta>`
redirect could reach a remote origin without firing `will-navigate` (SEC-3); the sidecar + GPU-probe
spawns omitted `windowsHide` → a console window could flash on Windows (REL-7); a `null` pixel count for
a *claimed* png/jpeg fell through to byte-cap-only, disabling the D4 pixel-bomb cap (SEC-6); the OCR page
PNG returned to main had no byte cap before recognition, unlike the vision path (REL-4); the GPU probe
child wasn't tracked by `shutdown()` (REL-8); plus two doc-only residuals (SEC-5 imageAnalyze raw-bytes,
SEC-4 session-scoped binary-verifier TOCTOU).
- **SEC-2 — permission CHECK handler, sharing the request handler's logic.** New
  `installPermissionCheckHandler` (`services/permissions.ts`) installs the synchronous counterpart on the
  same session. BOTH handlers route through ONE `grantsMicrophone(permission, webContents, options,
  audioScoped)` predicate — grant only `media`, audio-scoped, from the app's own WebContents — so request
  and check can never drift. The check path carries a SCALAR `mediaType` (not the request path's
  `mediaTypes` array); the shared predicate takes the path-specific audio test as an arg. The check
  handler does NOT log denials (high-frequency `permissions.query` polling; the request handler already
  records them). Wired in `index.ts` next to the request handler.
- **SEC-3 — one navigation guard, both events, both windows.** New `services/navigation-guard.ts`
  `installNavigationGuard(target, isAllowed)` attaches a single deny-by-default predicate to BOTH
  `will-navigate` AND `will-redirect`. Main window allows only its own shell (`http://localhost` dev /
  `file://` prod); the OCR rasterizer's hidden window denies ALL navigation (`() => false`). Structural
  `on` interface so it's unit-testable without `electron` and assignable from the real `WebContents`.
- **REL-7 — `windowsHide: true`** on the sidecar spawn (`sidecar.ts`, funnels every llama-server start —
  chat/embedder/reranker/vision) and the GPU-probe spawn (`gpu.ts`). No-op off Windows.
- **SEC-6 — reject the unparseable claimed image.** `validateAnalyzeRequest` (`vision/limits.ts`) now
  returns `decodeFailed` when `decodedPixelCount` is `null` for an already-known png/jpeg MIME (malformed/
  forged header) instead of admitting it to the sidecar on byte-cap-only.
- **REL-4 — OCR page PNG byte cap.** New electron-free `services/ocr/page-cap.ts`
  (`assertPageWithinByteCap`, `OCR_MAX_PAGE_PNG_BYTES`); the rasterizer rejects an over-cap page the
  moment it's received (before recognition / before the look-ahead holds it). Cap = **96 MiB**, sized to
  the WORST CASE of a *legitimate* 4096² RGBA page (≈64 MiB raw, ~that PNG-encoded), NOT the vision
  path's 20 MiB which would reject real dense scans; env `HILBERTRAUM_MAX_OCR_PAGE_BYTES`.
- **REL-8 — `child.unref()`** the GPU probe right after spawn so a wedged/cold-driver probe (not tracked
  by `shutdown()`) can never delay app quit; its own 10 s kill-timeout still reaps it.
- **SEC-5 + SEC-4 — accepted residuals, documented.** SEC-5 (`imageAnalyze` takes raw `req.imageBytes`
  for drag-drop, not token-bound) and SEC-4 (binary-verifier verdict is session-cached per path, not
  re-hashed every spawn — a deliberate consistency trade-off) recorded in `security-model.md`, not changed.
- **Tests (+11, teeth-verified then restored).** `permissions.test.ts` (+4): the check handler denies a
  non-audio/video/empty-scope permission + a foreign/null WebContents, allows audio from the app
  WebContents, and agrees with the request handler. `navigation-guard.test.ts` (+3): registers BOTH
  events; a remote `will-redirect` is prevented (and a deny-all worker blocks everything). `ocr-page-cap.
  test.ts` (+3): at/under cap passes, over throws, default cap ≥ 64 MiB. `vision-limits.test.ts` (+1): a
  claimed png/jpeg with an unparseable header → `decodeFailed`. **Teeth:** neutering each fix failed the
  matching test (check→`true`; drop will-redirect; remove the page-cap throw; remove the null-pixel
  reject), all restored. **Collateral:** the vision integration fixtures (`images-ipc.test.ts`,
  `vision-security.test.ts`) used placeholder image bytes that SEC-6 now correctly rejects — updated to
  valid minimal PNG headers (+ unique sentinel tails for the leak checks).
- **Data contracts (new):** `installPermissionCheckHandler(session, options)` +
  `PermissionCheckSessionLike`/`PermissionCheckDetails` (`permissions.ts`); `installNavigationGuard(
  target, isAllowed)` + `NavigationGuardTarget` (`navigation-guard.ts`); `assertPageWithinByteCap(png,
  maxBytes?)` + `OCR_MAX_PAGE_PNG_BYTES` (`ocr/page-cap.ts`); `ChildProcessLike.unref?()` (`sidecar.ts`).
  No IPC/schema-shape change; renderer untouched.
- **Docs:** `security-model.md` (baseline table rows for redirect + check handler; the perm-check §, the
  navigation-guard §, SEC-6 in the D4 vision §, SEC-5 + SEC-4 accepted-residual paragraphs).
  `architecture.md` (sidecar + probe `windowsHide`, probe `unref()` lifecycle in the GPU record, the OCR
  page byte cap + SEC-3 hidden-window note, the vision SEC-6 note). **Eyeball:** none — a main-side
  hardening phase, no UI surface. **Next: Phase 8 — API consistency, doc drift & housekeeping (API-1,
  BL-4, DATA-3/MAINT-3, DOC-2/3/4, DATA-4, API-2) — Low/Info.** See
  `docs/backend-audit-2026-06-27-remediation-plan.md` Phase 8._

_2026-06-28 — **Backend audit 2026-06-27 remediation — Phase 6 (Skills trust model; SEC-1, API-3, DOC-5,
TEST-8) — SKILLS-RUN TRUST-GATE PHASE, no renderer surface, no schema change, no new capability (branch
`backend-audit-2026-06-27-fixes`).** Suite **2319 passed / 39 skipped (+4 tests)**, typecheck clean, build
OK. The gate decides on ids/source only — skill bodies, document titles/content, and figures stay out of
logs/audit (the run payload remains `{skillId, toolName, documentCount}`); offline posture held.
**The problem (SEC-1, Medium):** `startSkillRun`/`runnableToolNames` gated on enabled/compatibility/confirm
but NOT on `source`/`trusted_level`; `resolveEffectiveTools(declared, declared)` collapsed the "user grant"
to "whatever the package declared"; and the manifest parser keeps `allowedTools` for any non-instruction
kind regardless of source. So a user could import a `.skill.zip` with `kind: tool` + `allowedTools: [...]`,
enable it, and drive the app's bank/invoice/redaction machinery over their own documents. The blast radius
is structurally bounded (the tool context has no FS/DB/net handle, scope is a single frozen document,
writes/exports are confirm-gated to a user-chosen path) — NOT an escape — but the trust decision was
incidental, not deliberate.
- **DECISION as built (owner): gate Tier-2 tools to APP skills.** Only built-in `source === 'app'` skills
  may run the wired Tier-2 tools (bank/invoice extraction, redaction, CSV export). A user-imported
  `kind: tool` skill may still DECLARE `allowedTools` (parser untouched — kept for a future per-tool
  user-grant UI; the import warning still says "reserves tools") but runs NONE of them until that UI
  exists. No grant UI built this phase — just the trust decision made explicit and enforced.
- **SEC-1 — one named gate at the runnable-tools choke point.** New `skillCanRunTools(skill)`
  (`skills/tool-runs.ts`, `source === 'app'`) with a comment citing audit SEC-1.
  `runnableToolNames` returns `[]` when `!skillCanRunTools(skill)` — so BOTH `listRunnableTools` and the
  run bar offer a user tool skill nothing. **Belt-and-braces:** `startSkillRun` (`registerSkillsIpc.ts`)
  re-checks `skillCanRunTools` and refuses a forged IPC call carrying a user skill's id with the generic,
  content-free `main.skills.run.unavailable` string (no title/path interpolated — the §22-M1 posture and
  the privacy sentinel-grep hold). App skills are completely unaffected. **Parser NOT changed** (the gate
  is at the run/runnable surface, not at parse time).
- **API-3 — `documentCount` left as the v1 constant `1`** (every wired tool is single-document) with an
  in-code TODO at `registerSkillsIpc.ts` that it must become a real count if a multi-document tool lands.
  No behaviour change.
- **Tests (TEST-8, +4, teeth-verified then restored).** `skills-tool-run-ipc.test.ts`: a user-imported
  `kind: tool` skill (declared `allowedTools`, force-enabled) → `runnableToolNames`/`runnableToolsForSkill`/
  `listRunnableTools` return `[]`, `startSkillRun` refused (friendly, content-free, NOTHING audited — the
  title sentinel never leaks); an APP skill with the same tools is unaffected (still runnable end-to-end).
  **Teeth:** flipping `skillCanRunTools` to `return true` failed exactly the three user-skill assertions
  (the app-skill test correctly stayed green); restored. The existing instruction-skill→[] (manifest) and
  `count_selected_documents` registry-only canary tests stay green.
- **Data contract (new):** `export function skillCanRunTools(skill: SkillRecord): boolean` in
  `skills/tool-runs.ts` — THE Tier-2 trust predicate (`source === 'app'`). No IPC/schema-shape change;
  renderer untouched (a user tool skill simply has no runnable tools to render).
- **Docs:** `security-model.md` "Skill tool ceiling (Tier-2)" — new SEC-1 record (app-skills-only posture,
  the named gate at both surfaces, user skills declare-but-don't-run, DOC-5). `architecture.md` §7 (Tier-2
  tool gate — SEC-1 trust gate + API-3 documentCount TODO) and §23 (close-out ledger — a backend-audit
  2026-06-27 follow-up note pointing at §7). **Eyeball:** none — a main-side trust-gate phase, no UI surface.
  **Next: Phase 7 — Electron + vision/runtime hardening (SEC-2/3/4/5/6, REL-4/7/8) — Low cluster.** See
  `docs/backend-audit-2026-06-27-remediation-plan.md` Phase 7._

_2026-06-28 — **Backend audit 2026-06-27 remediation — Phase 5 (RAG/embeddings honesty & quality;
RAG-1, EMB-1, DATA-2/EMB-2, EMB-4, MAINT-2/MAINT-5, TEST-3/5/7) — RETRIEVAL/ANSWER-HONESTY + VECTOR
HANDLING PHASE, no renderer surface, no schema change, no new capability (branch
`backend-audit-2026-06-27-fixes`).** Suite **2315 passed / 39 skipped (+4 tests)**, typecheck clean,
build OK. Content-class data (chunk text, node summaries, listing values) stays content-class —
nothing new logged/audited; offline posture held. **The problems:** the coverage listing over-claimed
"across the whole document" in a multi-doc scope where extraction ran on only one doc; the reranker
silently no-op'd on CJK/Thai (a space-less passage is one "word" → never truncated → 500 → fused-order
fallback); the compare path decoded vectors without the truncated-blob guard every other call site has;
`codec.ts` assumed native LE with no guard.
- **RAG-1 — "whole document" wording gated on ACTUAL scan coverage.** `buildListingAnswer`
  (`analysis/listing-answer.ts`) now picks `coverageWhole` only when `fullyChunked && scannedChunks >=
  totalChunks` (was `fullyChunked` alone). `fullyChunked` proves stored chunks are complete, NOT that
  every in-scope doc was scanned; a 2-doc scope extracted on one doc has `fullyChunked=true` but
  `scannedChunks < totalChunks` → honestly falls to `coverageSections` ("N sections scanned"). The
  single-doc fully-extracted path satisfies both → wording unchanged. `aggregateExtractions` untouched
  (the field keeps its chunking-invariant meaning; the gate combines both conditions at the wording site).
- **EMB-1 + MAINT-2 — token-aware reranker truncation via a SHARED budget helper.** New
  `runtime/context-budget.ts` (`REAL_TOKENS_PER_APPROX_TOKEN=2.2`, `maxInputApproxTokens(ctx)`,
  `truncateToContext(text, ctx)`) is the single home for sidecar input budgeting; the E5 embedder and the
  reranker both route through it (can't diverge again). The reranker dropped its naive whitespace
  `truncateWords` for the CJK/Thai-aware `truncateToApproxTokens`; per-field caps renamed
  `MAX_QUERY_APPROX_TOKENS`(160)/`MAX_DOC_APPROX_TOKENS`(320) and **clamped to the context budget in the
  constructor** (default 2048 → exactly 160/320, no behaviour change for English; a smaller configured
  context shrinks them so a rerank can't exceed n_ctx). The fused-order fallback (`rag/index.ts`) stays as
  a backstop but now rarely fires.
- **DATA-2/EMB-2 — the truncated-blob guard moved INTO `decodeVector`.** `decodeVector` now returns
  `Float32Array | null` — `dimensions <= 0` or `blob.length < dimensions*4` → `null` so EVERY caller skips
  the row uniformly. The two compare-path decodes (`doctasks/manager.ts`) now null-check-and-skip (a
  corrupt vector degrades the compare gracefully instead of throwing a `RangeError` that fails the task);
  the redundant pre-guards in `resident-cache.ts`/`node-vectors.ts` were replaced by the null-check (one
  guard point). Guard is one cheap branch — negligible on the hot resident-cache scan.
- **EMB-4/MAINT-5 — LE endianness assert.** `codec.ts` asserts the host is little-endian at module load
  (the BLOB encoding is locked LE Float32, spec §6) so a big-endian host fails loudly rather than silently
  corrupting every vector.
- **Tests (TEST-3/5/7, +4, all teeth-verified then restored).** `whole-doc-extract.test.ts`: multi-doc
  scope extracted on one doc → wording is `coverageSections`, never "whole document" (single-doc still
  says "whole document"). `reranker.test.ts`: a CJK passage > ctx still returns a reordering (mock 500s on
  overflow — proves no silent fall-through). `embeddings.test.ts`: `decodeVector` truncated/zero-dim →
  null, boundary decodes normally. `doctasks-compare.test.ts`: a truncated stored vector → the compare
  completes (no thrown RangeError). **Teeth:** reverting each fix failed the matching test — RAG-1
  printed "whole document"; EMB-1 word-split → mock HTTP 500 → rerank threw; DATA-2 guard off → RangeError
  failed the compare + the existing resident-cache scan test; all restored.
- **Data contracts (changed/new):** `decodeVector(blob, dimensions): Float32Array | null` (was non-null —
  `null` = skip a truncated/zero-dim blob; all callers null-check). New `runtime/context-budget.ts`:
  `export const REAL_TOKENS_PER_APPROX_TOKEN = 2.2`; `export function maxInputApproxTokens(contextTokens:
  number, minTokens=16): number`; `export function truncateToContext(text: string, contextTokens: number,
  minTokens=16): string`. No IPC/schema-shape change; renderer untouched.
- **Docs:** `rag-design.md` §11 (reranker prose — token-aware truncation + EMB-1), new §12.4 (token-aware
  sidecar truncation contract + codec LE assert + DATA-2 guard), §14.5 (RAG-1 wording gate). **DOC-3**
  (E5 no-prefix retrieval ceiling) deliberately LEFT for Phase 8 (its scope). **Eyeball:** none — a
  main-side retrieval/answer/vector phase, no UI surface.
  **Next: Phase 6 — Skills trust model (SEC-1 user `kind:tool` gate, API-3 documentCount note) — ⚠️ has a
  product DECISION (gate to app skills vs allow+document) to resolve before coding.** See
  `docs/backend-audit-2026-06-27-remediation-plan.md` Phase 6._

_2026-06-28 — **Backend audit 2026-06-27 remediation — Phase 4 (Ingestion robustness & cap enforcement;
REL-5, REL-9, REL-10, BL-5, MAINT-4) — MAIN-SIDE PARSING/WALK PHASE, no renderer surface, no schema
change, no new capability (branch `backend-audit-2026-06-27-fixes`).** Suite **2311 passed / 39 skipped
(+11 tests, +1 skipped = the symlink-cycle test, skips locally where dir-symlinks need elevation)**,
typecheck clean, build OK. Content-extraction changes only — nothing new logged/audited; offline posture
held. **The problems:** the preview re-parse bypassed the whole import cap stack (a 4000-page PDF could
wedge the main process on a user "Show more"); `expandPaths` could recurse forever on a symlink cycle;
`resolvePageYear` spread a whole page's y-array into `Math.max(...)` (RangeError on a crafted page); a CSV
data row wider than its header silently dropped the overflow cells.
- **MAINT-4 + REL-5 — ONE cap-enforcement decorator, now covering preview.** New
  `parseWithLimits(parser, source, ctx, limits, timeoutMessage?)` in `ingestion/index.ts` is the single
  point every parse entry routes through: ingest (`prepareDocument`), `extractDocumentPreview`, and
  `extractDocumentPreviewPage` (via the former). It injects `maxPages`/`maxInflatedBytes` from the
  resolved limits (a caller-set ctx cap — the layout seam — WINS) and races non-audio parses against the
  wall-clock `parseTimeoutMs`; **audio stays exempt** (its `signal` + the transcriber idle watchdog bound
  it). The **ingest path is byte-for-byte unchanged** (decorator injects the same caps it set inline
  before; verified via the unchanged ingestion/limits suite). The preview formerly threaded none of the
  caps (only `maxPages`, layout-only) → REL-5 closed: the preview now enforces `maxPages` +
  `maxInflatedBytes` + a timeout backstop on every page. The byte ceiling (M-1) stays the ingest path's
  pre-selection stat (the preview reads the already-import-capped stored copy). Timeout *message* differs
  by caller: ingest passes persist-canonical English (→ `error_message`); preview passes a localized
  `tMain(...)` emission (transient IPC throw, never persisted).
- **REL-9 — symlink-cycle guard in `expandPaths`.** `walk()` tracks the `realpathSync` of every dir on
  the *current recursion path* in a Set and skips a dir whose real path is already an ancestor — precise
  cycle detection: every acyclic walk's expansion set is byte-identical (a symlink to a *distinct* dir is
  not an ancestor → still followed per the ING-4 intent), only a true cycle (`a/loop -> ..`) is cut.
- **REL-10 — single-pass y-range fold in `resolvePageYear` (`pdf-layout.ts`).** Replaced
  `Math.max(...ys)`/`Math.min(...ys)` with an O(n) loop (no arg-count limit). The per-row
  `Math.min(...money.map(...))` at `pdf-layout.ts:384` is bounded by tokens-per-row → left as a spread
  (noted in-code).
- **BL-5 — ragged CSV (`csv.ts`).** The header→value emit now iterates `Math.max(header.length,
  row.length)`; overflow cells (beyond the header) ride along under a generated `colN:` label (empty
  overflow cells skipped → no trailing-comma noise). The in-header and narrower-than-header cases are
  unchanged (byte-identical emit rule).
- **Tests (+11, all teeth-verified then restored).** `ingestion-limits.test.ts`: `parseWithLimits`
  decorator unit suite (cap injection; caller-cap wins; wedged non-audio → timeout not hang; audio
  exempt; signal+fields pass-through) + preview cap stack (PDF `maxPages` bounded; DOCX `maxInflatedBytes`
  throws; `extractDocumentPreviewPage` caps per page). `ingestion.test.ts`: ragged-CSV overflow kept
  (BL-5) + narrower-than-header unchanged; symlink-cycle terminates + file found exactly once (REL-9,
  `it.skipIf(!symlinkOk)` — runs in CI). `pdf-bank-layout.test.ts`: `resolvePageYear` over 500k fragments
  → no RangeError (REL-10). **Teeth:** reverting each fix failed the matching test — REL-9 file-count
  1→64 (junction repro), REL-10 RangeError, BL-5 cols dropped, cap-injection 4 tests, timeout 15 s hang,
  audio "timed out", preview-page 3≠2; all restored.
- **Data contract (new, additive):** `export function parseWithLimits(parser: DocumentParser, source:
  string, ctx: ParseContext, limits: IngestionLimits, timeoutMessage?: string): Promise<ParsedDocument>`
  — THE parse-with-caps enforcement point (default `timeoutMessage` = persist-canonical
  `main.ingest.parseTimeout`). `ExtractPreviewOptions` gains optional `limits?: IngestionLimits` (test
  seam; omit → `resolveIngestionLimits()`); `extractDocumentPreviewPage` gains a trailing optional
  `opts: ExtractPreviewOptions` (forwarded to `extractDocumentPreview`). No IPC/schema-shape change; the
  renderer preview callers are untouched (default limits).
- **Docs:** `rag-design.md` §1 (expandPaths symlink-cycle guard), §2 (new "Cap stack — one enforcement
  point (`parseWithLimits`)" record + preview coverage), §3 Cap bullet (pre-parse vs chunk-cap pointer);
  `architecture.md` ING-4 record (symlink-cycle guard + teeth) and FE-6/preview record (preview cap
  stack). **Eyeball:** none — a main-side parsing/walk phase, no UI surface.
  **Next: Phase 5 — RAG/embeddings honesty & quality (RAG-1 coverage wording, EMB-1 reranker CJK/Thai
  truncation, DATA-2 `decodeVector` guard, EMB-4 LE assert).** See
  `docs/backend-audit-2026-06-27-remediation-plan.md` Phase 5._

_2026-06-28 — **Backend audit 2026-06-27 remediation — Phase 3 (Cancellation & timeouts; REL-1, REL-2,
REL-3, REL-6, TEST-4) — MAIN-SIDE RELIABILITY PHASE, no renderer surface, no schema change, no new
capability (branch `backend-audit-2026-06-27-fixes`).** Suite **2300 passed / 38 skipped (+8)**,
typecheck clean, build OK. **The problem:** one crafted/edge-case audio or image could wedge a shared
worker for the whole session, and cancel was a no-op mid-operation.
- **REL-1 (Medium) — audio transcription uncancellable + time-unbounded.** `ParseContext` had no
  `signal`; the ingestion call site exempts audio from `withParseTimeout`; `WhisperCliTranscriber.run`
  installed an abort listener that was **never armed** (no signal supplied) and had **no per-spawn
  timeout** → a pathological audio that makes whisper spin hung the ingestion slot indefinitely.
- **REL-2 (Medium) — OCR per-page recognition had no timeout/abort.** `tesseract.ts` checked
  `signal.aborted` only BEFORE `await worker.recognize`; recognitions serialize through one worker, so
  one hung image wedged every later page; Cancel only landed between pages.
- **REL-3 (Medium) — dictation IPC had no timeout/cancel/concurrency guard.** A wedged child hung the
  mic spinner forever; rapid presses spawned N concurrent whisper processes.
- **REL-6 (Low) — transcriber transcript defaulted to `tmpdir()` when `workDir` omitted** → recognised
  speech (content) could land outside the crash sweep (latent; both prod callers passed `workDir`).
**As built (implementer's picks):**
- **REL-1 — inactivity watchdog (not a fixed total ceiling) + real threaded signal.** Took an INACTIVITY
  watchdog in `transcriber/cli.ts run()`: reset on every stdout/stderr chunk, fires only after the child
  is completely silent for `idleTimeoutMs` (default 15 min, `HILBERTRAUM_WHISPER_IDLE_TIMEOUT_MS`,
  ctor-injectable). Rationale over the audit's suggested "N× duration / fixed max": whisper emits `-pp`
  progress continuously, so inactivity cleanly distinguishes a spinning/hung child (no output → killed +
  rejected) from a slow-but-advancing one (keeps resetting) — no false kills on legitimately long audio,
  no need to probe duration up front. The watchdog/timeout errors carry only durations, never transcript.
  Signal threaded end-to-end: `IngestionDeps.signal` → `ParseContext.signal` → `AudioParser.parse` →
  `transcribe({ signal })`, arming the previously-dead abort listener. `registerDocsIpc` creates a per-job
  `AbortController` and aborts it on a mid-job workspace lock (belt-and-suspenders with the lock's
  existing `transcriber.suspend()`, which already kills children directly).
- **REL-2 — `Promise.race(recognize, timeout, abort)` + terminate-on-interrupt.** `recognize()` races the
  WASM job against a per-page timeout (`recognizeTimeoutMs`, default 2 min,
  `HILBERTRAUM_OCR_PAGE_TIMEOUT_MS`, ctor-injectable) AND the abort signal; on timeout OR mid-page abort
  it `terminate()`s the worker (cleared → recreated lazily) and rejects — the only real abort since a
  tesseract.js WASM job isn't cooperatively cancellable. A plain recognition error still leaves the worker
  intact (unchanged). `stop()` refactored onto the shared `terminateWorker()`.
- **REL-3 — single-flight guard + wall-clock abort.** A second `dictation:transcribe` while one is in
  flight is rejected with `DICTATION_BUSY_MESSAGE` BEFORE touching disk/spawn (no double-spawn). A
  `maxDurationMs` ceiling (default 10 min, `HILBERTRAUM_DICTATION_TIMEOUT_MS`, injectable via the new
  `registerDictationIpc(ctx, { maxDurationMs })` test seam) drives an `AbortController` → a wedged child
  is killed and the renderer gets the friendly failure. Temp WAV shredded in `finally` on every path.
- **REL-6 — `TranscribeOptions.workDir` is now REQUIRED (type-level) + runtime fail-closed guard.** Dropped
  the `tmpdir()` fallback (and the `tmpdir` import); an empty `workDir` throws before any spawn rather than
  stranding content outside the `.parse` sweep. Both prod callers already pass it; fixed the 2 call sites
  that relied on the default (transcriber stop() test, manual whisper-smoke).
- **Tests (TEST-4, +8, all teeth-verified then restored).** `transcriber.test.ts`: inactivity watchdog
  kills a silent child + rejects; an aborted signal kills the in-flight child (the threaded-cancel path);
  empty-workDir fails closed before spawn. `audio-ingestion.test.ts`: abort mid-transcribe (blocking mock)
  → task `failed`, signal proven threaded all the way to `transcribe`. `ocr.test.ts`: per-page timeout →
  worker terminated, chain recovers on the next page with a fresh worker; mid-page abort → worker
  terminated. `dictation-ipc.test.ts`: concurrent dictation rejected, no double-spawn; wedged child rejects
  on the wall-clock timeout (not a hang). **Teeth:** neutering each fix (watchdog kill, signal threading,
  OCR terminate, dictation guard, dictation timeout, workDir guard) failed the matching test (assertion or
  15 s test-timeout); all restored.
- **Data contracts (new, additive/optional — non-audio parsers unaffected):** `ParseContext.signal?:
  AbortSignal` (forwarded only by `AudioParser`; text parsers ignore it, still bounded by
  `withParseTimeout`); `IngestionDeps.signal?: AbortSignal` (threaded to `ParseContext.signal`).
  `TranscribeOptions.workDir` is now **required** (no tmpdir default). New tuning envs:
  `HILBERTRAUM_WHISPER_IDLE_TIMEOUT_MS` / `HILBERTRAUM_OCR_PAGE_TIMEOUT_MS` /
  `HILBERTRAUM_DICTATION_TIMEOUT_MS`. No IPC/schema-shape change.
- **Posture (held):** no network/telemetry; transcription/OCR output stays content-class (never logged/
  audited) — only ids/durations ride the watchdog/timeout paths. Full parser suite stays green (signal is
  optional, so every non-audio parser is byte-unaffected).
- **Docs:** `architecture.md` transcriber/dictation/OCR sections each carry the cancellation & timeout
  record (REL-1/2/3/6); `known-limitations.md` Audio/Dictation/OCR sections each state the operation now
  self-recovers via watchdog/timeout (no "can hang the session" assumption). Plan checkbox flipped to ✅.
  **Eyeball:** none — a main-side reliability phase, no UI surface.
  **Next: Phase 4 — Ingestion robustness & cap enforcement (REL-5 preview cap-stack, REL-9 symlink-cycle,
  REL-10 `Math.max(...spread)`, BL-5 ragged CSV, MAINT-4 `parseWithLimits` decorator).** See
  `docs/backend-audit-2026-06-27-remediation-plan.md` Phase 4._

_2026-06-28 — **Backend audit 2026-06-27 remediation — Phase 2 (Financial-extraction correctness;
BL-1, BL-2, BL-3, TEST-2, TEST-6) — MAIN-SIDE PARSING/AGGREGATION PHASE, no renderer surface, no schema
change, no new capability (branch `backend-audit-2026-06-27-fixes`).** Suite **2292 passed / 38 skipped
(+6)**, typecheck clean, build OK. Parsing/aggregation logic only — figures stay content-class (never
logged/audited/exported); the audit payload is untouched. **The bugs:**
- **BL-1 (High) — value-date column mis-parse.** The shared `MONEY_RE` (`tools/money.ts`) reads a
  `dd.mm.20yy` date's `.20yy` tail as a 2-decimal amount (`07.06.2026` → `07.06.20` → 706.20). The line
  parsers (`tools/bank-statement.ts parseLine`, `tools/invoice.ts parseLineItem`) stripped only the FIRST
  whitespace token as the date, so a DACH statement printing BOTH a booking date (Buchungstag) and a value
  date (Wertstellung/Valuta) left the value date in the money-scanned remainder → either an empty
  description (row **silently dropped**) or a wrong amount.
- **BL-2 (Medium) — currency-blind completeness.** `assessCompleteness`/`isStatementComplete` summed
  `opening + Σamounts == closing` and `reconcileBalances` chained `prevBalance + amount` across currencies
  → a mixed-currency statement could be mislabelled `complete`/`contradicted` or carry a spurious mismatch.
- **BL-3 (Low) — currency-blind category totals.** `analysis/bank-statement.ts categoryTotals` keyed by
  category alone, summing signed amounts across currencies (gated in practice by the single-currency render
  branch, but latently wrong).
**As built (implementer's picks):**
- **BL-1 — took the recommended default (date-stripping, NOT the MONEY_RE lookahead).** New shared
  `tools/money.ts splitLeadingDates(line)` consumes the WHOLE leading run of date tokens before the money
  scan (capped at two — booking + value — and stops at the first non-date token so a description is never
  consumed; handles either column order). `parseLine` records the first as the booking `date` and the
  second as the optional `valueDate` (the schema/CSV already carry it — so the fix also **enriches** the
  data rather than discarding the value date); `parseLineItem` strips + discards (line items have no date
  field). **Scoped to the description/amount boundary only** — the money scanner's last-token readers
  (`lastMoneyOnLine`/balance/invoice-total) take the trailing figure and were never affected, left
  untouched (confirmed: existing balance/total fixtures unchanged). This fixes the **line-parser fallback**
  (plain-text statements, CSV, the invoice path with no geometry pass); the auto-run geometry path's own
  out-of-column value-date handling is the separate booking-date column model (architecture §21).
- **BL-2 — mirrored the `summarizeCashflow` `currencies.size === 1` guard.** `assessCompleteness` returns
  `'unverified'` for a mixed-currency statement (first check, before the mismatch/opening-closing logic);
  `reconcileBalances` returns every row `unknown` (never reconciled). **`buildBankAnswer`'s honesty
  branches did NOT change** — the mixed-currency answer was already gated on `summary.currency` (the
  `noCurrency` branch), independent of `status` — so the SKILL.md ⇔ TS parity test stays green with no
  wording change; the fix hardens the **public predicates** a future caller might trust.
- **BL-3 — keyed `categoryTotals` by `(category, currency)`.** Each `CategoryTotal` now carries its own
  `currency`; `buildBankAnswer` renders `c.currency` (identical to `summary.currency` on the only branch
  that renders the breakdown — the single-currency one — so the live output is byte-identical, confirmed by
  the unchanged category tests). Removes the latent currency-blindness for any future reuse.
- **Tests (TEST-2/TEST-6, +6).** `skills-bank-statement-tool.test.ts`: the 4-column `Buchung Valuta Betrag
  Saldo` fixture (both rows parse — none dropped — value date captured, amount = −45.90 not 706.20, Σ feeds
  the total), a single-date-row regression (valueDate stays undefined), mixed-currency `assessCompleteness`
  ⇒ `'unverified'` (TEST-6) and `reconcileBalances` ⇒ all-`unknown`. `skills-invoice-tool.test.ts`: a
  `parseLineItem` leading-date strip (no misread unit price). `skills-analysis-bank.test.ts`: the 4-column
  statement **end-to-end** → the verified (`caveat`) total, no `706.20` leak. **Teeth verified:** reverting
  `parseLine` to the single-token strip failed both BL-1 fixtures; removing each BL-2 guard flipped the
  mixed-currency verdict (`assessCompleteness`/`reconcileBalances` tests failed) — both restored. **BL-3
  has no behavioral teeth:** the function is private and only rendered single-currency, so its correctness
  manifests only on a path that isn't rendered; the unchanged category tests prove the live path is
  byte-identical (the relevant safety property).
- **Posture (held):** no network/telemetry; this phase changes parsing/aggregation only — extracted figures
  live only in the encrypted workspace DB and are never logged/audited/exported; the run audit payload stays
  ids/counts. No IPC/schema-shape change (`valueDate` was already on the row schema + CSV; now populated).
- **Docs:** `architecture.md` "Skills — design record" §10 (new "Financial-extraction correctness" record —
  BL-1 line-parser value-date handling, BL-2 single-currency precondition, BL-3 currency-keyed totals) + §21
  cross-ref (the gate's single-currency precondition; BL-1 line-parser vs the geometry column model). Plan
  checkbox flipped to ✅. **Eyeball:** none — a main-side parsing/aggregation phase, no UI surface.
  **Next: Phase 3 — Cancellation & timeouts (REL-1 audio-ingest abort+watchdog, REL-2 OCR per-page timeout,
  REL-3 dictation timeout/concurrency, REL-6 transcriber workDir; TEST-4).** See
  `docs/backend-audit-2026-06-27-remediation-plan.md` Phase 3._

_2026-06-27 — **Backend audit 2026-06-27 remediation — Phase 1 (Document-deletion data integrity;
DATA-1, DOC-1, MAINT-1, TEST-1) — MAIN-SIDE DATA-CORRECTNESS PHASE, no renderer surface, no new
capability (branch `backend-audit-2026-06-27-fixes`).** Suite **2286 passed / 38 skipped (+4)**,
typecheck clean, build OK. **The bug (DATA-1, High, reproduced against `node:sqlite`):**
`deleteDocument` shredded the file + deleted chunks/embeddings, then threw
`SQLITE_CONSTRAINT_FOREIGNKEY` on the final un-transacted `DELETE FROM documents` because the
`bank_statements`/`invoices` (and child) tables reference `documents(id)` with **no `ON DELETE
CASCADE`** and were never cleaned up — leaving a permanently corrupt, undeletable document, and
contradicting the deletion-safety invariant in `known-limitations.md` §39–46 (DOC-1).
**As built (implementer's picks):**
- **Centralised teardown (MAINT-1).** New private `ingestion/index.ts` `purgeDocumentDerivatives(db,
  id)` = the single authoritative "everything hanging off a document" list, in FK order: embeddings →
  chunks → tree_nodes → `purgeSkillDataForDocument`. The bank/invoice half is a new **exported**
  `skills/run.ts purgeSkillDataForDocument(db, documentId)` = `deleteBankStatementsForDocument`
  (REUSED — the existing re-extract "replace" delete: bank_corrections → bank_transactions →
  bank_statements) + a new sibling `deleteInvoicesForDocument` (invoice_line_items → invoices). No
  duplication of the bank ordering. The CASCADE-from-documents tables (`document_collections`,
  `conversation_documents`, `extraction_records`) are left to the final `DELETE FROM documents`;
  `tree_nodes` is cleared explicitly anyway (mirrors the re-index teardown) so the list stays complete
  on every drive.
- **Atomicity.** `deleteDocument` now wraps `purgeDocumentDerivatives` + the row delete in ONE
  `BEGIN…COMMIT` (ROLLBACK + rethrow on any throw), and **shreds the workspace copy only AFTER the
  commit** — closing the window where the file was destroyed before a failing delete left a corrupt
  row. `invalidateResidentVectors` stays (post-commit).
- **DECISION (took the recommended default, confirmed against the code).** Explicit ordered manual
  delete (works on EXISTING drives immediately — load-bearing there) **AND** `ON DELETE CASCADE` added
  to the SCHEMA down BOTH full chains (`bank_statements.document_id` + `bank_transactions.statement_id`
  + `bank_corrections.transaction_id`; `invoices.document_id` + `invoice_line_items.invoice_id`) so a
  *fresh* DB is safe even on a bare `DELETE FROM documents` (defense-in-depth). **Why full-chain, not
  just the two top FKs:** a top-only cascade would itself FK-throw on a fresh DB (the un-cascaded child
  rows block the parent's cascade) — so cascading the whole chain is the only coherent defense-in-depth.
  **Skipped the table-rebuild migration** for existing drives (heavy on portable USB; the ordered
  delete already closes the bug there — `CREATE TABLE IF NOT EXISTS` can't alter the existing FK, which
  is fine).
- **Reindex parity (confirmed unaffected).** `index.ts:667–687` deletes chunks/embeddings/tree but NOT
  the document row, so no FK issue; bank/invoice rows correctly persist as stale, gated by
  `extractor_version` — untouched by this phase.
- **Test (TEST-1) — `tests/integration/document-delete-derivatives.test.ts` (+4).** Drives the REAL
  `runBankExtraction` + `runInvoiceExtraction` (via `readDocumentSegments`) onto one document, plus a
  manual `bank_corrections` row (no UI writes it) + embeddings + tree_node, on a **simulated pre-fix
  drive** (`degradeSkillTablesToLegacyFk` reads each table's live DDL and strips the cascade — faithful
  "existing drive", carries migrated columns automatically), then `deleteDocument` → succeeds, every
  derived row gone, file shredded, `skill_runs` (no FK) intentionally kept. Plus: a fresh-schema
  bare-delete cascades the whole chain; and the **IPC end-to-end** path (`registerDocsIpc` →
  `IPC.deleteDocument` on a doc WITH a tool run) fires `document_deleted` — the exact audit-ipc gap
  TEST-1 named. **Teeth verified:** neutering `purgeSkillDataForDocument` made the service + IPC tests
  fail with `FOREIGN KEY constraint failed` (and the txn rolled back — the row survived); reverted.
- **Data contract (new):** `purgeSkillDataForDocument(db, documentId)` (exported from `skills/run.ts`)
  is the authoritative bank+invoice teardown for a document, FK-ordered, runs inside the caller's
  transaction, ids/figures only. `purgeDocumentDerivatives` (private to ingestion) is the full
  derived-row teardown that `deleteDocument` routes through. Anyone adding a new document-scoped table
  extends `purgeDocumentDerivatives` (and adds the cascade to fresh schemas).
- **Posture (load-bearing):** no network/telemetry; bank/invoice rows are content-class but this phase
  touches only ids/row counts — nothing logged/audited/echoed; the delete audit payload stays
  `{documentId}`. No IPC/schema-shape change beyond the additive cascade clauses (no data migration).
- **Docs:** `known-limitations.md` §39–46 (deletion-safety paragraph — bank/invoice now handled by the
  ordered cleanup + fresh-schema CASCADE; pre-skills version-skew caveat), `architecture.md` "Skills —
  design record" §10 (new Deletion-safety paragraph) + "Document organization — design record" §3
  (cascade cross-ref), `rag-design.md` `deleteDocument` IPC row. Plan checkbox flipped to ✅.
  **Eyeball:** none — a main-side data-correctness phase, no UI surface.
  **Next: Phase 2 — Financial-extraction correctness (BL-1 value-date money parse, BL-2 mixed-currency
  completeness, BL-3 currency-blind categoryTotals; TEST-2/TEST-6).** See
  `docs/backend-audit-2026-06-27-remediation-plan.md` Phase 2._

_2026-06-26 — **Skills & Tools audit — Phase 11 (FINAL: Test backfill & residuals; T-1, R-1, R-2) —
TESTS/DOCS PHASE, no renderer surface, no new capability (branch `skills-tools-audit-2026-06-26`). ALL 11
PHASES REMEDIATED — audit complete.** Suite **2282 passed / 38 skipped (+3)**, typecheck clean, build OK.
A P3 tests/docs phase: it backfills the test gaps the audit clustered under T-1 (adding ONLY the genuinely
missing edges, verifying the rest already-covered — no padding) and resolves the two documented residuals.
The tool gate, the IPC payload (`{skillId, toolName, documentCount}`), and every schema are unchanged.
**As built (implementer's picks):**
- **T-1 — added only the genuinely-missing categorizer edges (`skills-categorizer.test.ts`, +3).** An
  **empty input** makes NO model call and returns an empty result (`modelAssisted:false`), and the **exact
  batch boundary** — exactly `CATEGORIZER_BATCH_SIZE`(20) model-bound rows is ONE call, 21 is two, a 1-row
  batch is one — pinning the off-by-one the prior 25-row "batches of 20" test only *brackets*. `Shop N`
  descriptions never prefilter, so the call count IS the batch count. **Teeth-verified:** a transient
  batch-step off-by-one (`+= SIZE-1`) made the 20⇒1 assertion fail ("expected length 1, got 2"); reverted.
- **T-1 — the other clustered gaps were verified ALREADY COVERED and deliberately NOT re-added** (the
  judgement call the plan left to the implementer; recorded so the suite isn't padded): cross-lane
  concurrency PC-1 (`skills-concurrency.test.ts`, Phase 9 — 3 cases incl. teeth); multi-doc `docIds[0]` +
  the Radix chooser + the no-title `SkillRunState` privacy sentinel ("never leaks a document TITLE …") +
  the U-2 no-auto-categorize behaviour (`skills-tool-run-ipc.test.ts`, Phases 5/6); the whole-batch-drop /
  retry-once / char-cap / 25-rows⇒2-calls categorizer cases (`skills-categorizer.test.ts`, Phase 2); the
  C-3/C-4 completeness numerics — cent-exact many-row drift + `Kontostand per` dated/lone-line
  (`skills-bank-statement-tool.test.ts`, Phase 3). The `skills-privacy-guard.test.ts` /
  `skills-ipc.test.ts` sentinel greps and all skills/doctask tests stay green.
- **R-1 — auto-fire corpus is intentionally narrow (no rows invented).** Confirmed by grep that
  `document-redaction` is STILL the ONLY app skill opting into `triggers.autoFire`. The eval gate already
  covers it: `APP_SKILL_IDS` + the 33-turn `tests/fixtures/skill-triggers/corpus.json` (four
  `document-redaction` turns) feed the S13b gate (`fired-wrong == 0` AND `precision ≥ 0.95`). Per the
  plan's explicit fallback, since NO new skill opts in, **no corpus rows were added** — the corpus is
  deliberately scoped to the auto-fire surface; the eval gate is unchanged.
- **R-2 — run-surface eyeball deferred (re-affirmed; surfaced for opt-in).** The live `SkillRunBar`
  Playwright walk (`walk-skills-runbar.mjs`, recipe in `docs/design-review/skills-s12/README.md` — the
  script itself is not yet written; only `walk-skills-composer.mjs` exists) needs a GUI session a test
  harness can't drive. Every visual state stays unit-covered by `SkillRunBar.test.tsx`. **Default =
  re-affirm the honest deferral (no fake captures), the documented default since Phase 5.** OWNER OPT-IN:
  if you want the PNGs, run the recipe on a GUI machine (the Electron eyeball driver recipe is in memory)
  and commit them.
- **Doc-lifecycle close-out (CLAUDE.md rule — the genuine decision this phase made).** The audit's design
  records were already folded into `architecture.md` §7/§9/§19/§22 (+§4/§6/§8/§12/§13/§18/§21 and
  `security-model.md`) as each phase shipped, so the standalone plan is fully implemented. **Decision:
  DELETED `docs/skills-tools-audit-2026-06-26.md`** (mirroring the 2026-06-13 audit closeout) and condensed
  the remaining live status into a new **`architecture.md` §23 "Skills & Tools audit (2026-06-26) —
  remediation close-out"**: a per-finding ledger (every finding → phase → disposition → the § its record
  lives in), the Phase-11 "as built" picks, the all-11-remediated note, and the held-posture paragraph;
  plus a §-anchor-legend row so a code comment's `audit <ID>` citation still resolves. **Why the §3/§13
  row-flips landed in §23, not in the audit file:** editing then deleting the file in the SAME commit would
  record the flips nowhere (the deletion diff shows HEAD's un-flipped rows) — so the fixed-status + picks
  live durably in §23 instead. The full original report stays **recoverable in git history at `bd2acdb`**
  (the parent of this close-out commit). Kept-as-SSOT was rejected: not "cited as a unit" (code cites
  individual finding IDs, which §23 resolves), and the rule defaults to delete.
- **Posture (load-bearing):** no network/telemetry; the content class (skill bodies, draft question,
  figures, redacted text, document text AND titles/filenames) is never logged/audited/echoed — the audit
  payload stays `{skillId, toolName, documentCount}`; no schema/IPC change; the tool gate adds no new
  DB/FS/net capability; i18n parity compile-enforced (no new keys this phase — tests/docs only).
- **Eyeball:** none — a tests/docs phase with no UI surface (R-2 is the run-surface eyeball, deferred above).
  **Next: NONE — the Skills & Tools audit is fully remediated (all 11 phases). Branch
  `skills-tools-audit-2026-06-26` is several commits ahead of origin and intentionally unpushed.**_

_2026-06-26 — **Skills & Tools audit — Phase 10 (Cleanup & contract parity; X-1, X-2, A-1 test) — MAIN-SIDE
REFACTOR-AND-TEST PHASE, no renderer surface, no new capability (branch `skills-tools-audit-2026-06-26`).**
Suite **2279 passed / 38 skipped (+9)**, typecheck clean, build OK. A P3 phase that removes a drift
surface and pins a contract; the tool gate, the IPC payload (`{skillId, toolName, documentCount}`), and
every schema are unchanged. **As built (implementer's picks):**
- **X-1 — ONE scope→documents helper.** New `services/skills/scope-documents.ts` exports
  `documentsInScope(db, scope, { requireChunks })` — the single definition of "indexed documents in a
  resolved scope," built once (shared scope filter + `status='indexed'` + optional `EXISTS chunks` +
  deterministic `ORDER BY created_at, id`). **Return shape = rows of `{id, title, mimeType}`, callers
  project** (the chosen pick over an ids-core + signals-wrapper — simpler for five callers with three
  projections). **All FIVE prior copies routed through it:** `resolveInScopeDocumentIds` (`tool-runs.ts`,
  `requireChunks:false`, ordering preserved → `[0]` stays the default run target), `inScopeDocSignals`
  (`scope-signals.ts`, `false`, projects title/MIME main-side — logs-nothing + title-stays-main-side
  intact), and the three analysis handlers (`bank-statement.ts`, `invoice.ts`, `whole-doc-skills.ts`,
  `true`). **Predicate chosen deliberately:** the chat-analysis handlers read the stored `chunks`
  (`true`); the run path re-extracts from the stored copy and the suggest/auto-fire path is keyword/MIME
  signal only (`false`) — the two-predicate split is now intentional + documented, not accidental drift.
  The RAG router's own `registerRagIpc.documentsInScope` (different layer) is left as a deliberate sibling
  (the audit's X-1 named the five skills-subsystem copies).
- **X-2 — KEEP `count_selected_documents` as the documented test-only canary** (the recommended default;
  removing it churns the gate tests for zero behaviour gain). Registered but **not wired** to a `run.ts`
  dispatch seam (`buildToolRunner` returns `null`) ⇒ no live capability. Documented at the registry entry
  + `REGISTRY` line + architecture.md §7; pinned with teeth BOTH ways — `skills-tool-registry.test.ts`
  asserts it is registered (drop it ⇒ fail); a new `skills-tool-run-ipc.test.ts` case asserts
  `buildToolRunner` returns `null` for it (wire it up ⇒ fail).
- **A-1 — SKILL.md ⇔ TS parity test (`tests/integration/skills-skillmd-parity.test.ts`, +8).** The
  SKILL.md body is inert on the exhaustive answer path (the answer is deterministic TS), so the test pins
  the contract BOTH directions for bank + invoice: the body still states each honesty bullet AND
  `buildBankAnswer`/`buildInvoiceAnswer` still emit the matching honest branch for a constructed
  unreconciled / contradicted / mixed-currency / missing-figure case. Expected copy derived via `tr()` (so
  re-wording flows through equally — parity is body↔branch, not wording). **Teeth verified:** a transient
  drift to the body AND to the `contradicted` branch each failed the test; reverted.
- **Posture (load-bearing):** no network/telemetry; the content class (skill bodies, draft question,
  figures, document text AND titles/filenames) is never logged/audited — `documentsInScope` logs nothing
  and titles never cross IPC from it; audit payload still `{skillId, toolName, documentCount}`; the tool
  gate adds no new DB/FS/net capability; i18n parity compile-enforced (no new keys this phase).
- **Docs:** architecture.md §7 (the X-2 canary note) + §19 (the X-1 shared-helper paragraph + the A-1
  body-inert-but-parity-pinned note + the Tests list); audit doc §3 X-1/X-2/A-1 rows + the Phase-10 index
  row flipped to ✅ fixed (Phase 10) + the Phase-10 "As built" prose.
- **Eyeball:** none — a main-side refactor + tests with no UI surface (R-2 unaffected).
  **Next:** Phase 11 (final): T-1 test backfill (the gaps not closed by earlier phases) + the R-1
  (auto-fire corpus) / R-2 (run-surface eyeball) residuals — close or explicitly re-affirm in BUILD_STATE._

_2026-06-26 — **Skills & Tools audit — Phase 9 (Cross-lane write safety; PC-1) — MAIN-SIDE CONCURRENCY-
CORRECTNESS PHASE, no renderer surface (branch `skills-tools-audit-2026-06-26`).** Suite **2270 passed /
38 skipped (+3)**, typecheck clean, build OK. **The fix:** three INDEPENDENT execution lanes can touch the
bank/invoice tables — **Lane A** chat analysis auto-run, **Lane B** the `SkillRunController` button run,
**Lane C** the `DocTaskManager` categorize — and had **NO cross-lane lock**, so a chat re-extract
(`replaceExisting` DELETE) could race a button run / categorize on the SAME statement. The main process is
single-threaded, so this was NOT an OS data race but **cooperative interleaving across `await` points**
(one lane parked at an await while another runs its DELETE+INSERT) → "statement vanished mid-read",
orphaned rows, a nondeterministic final state. A new lightweight **per-document async mutex** now
serializes every write-capable section by `documentId`. **§2.3 update:** "Lane A and Lane B are mutually
unaware" → now **serialized by a per-document lock** (`withDocumentLock`); unrelated documents still run
fully concurrently. **As built (implementer's picks):**
- **`skills/doc-lock.ts` (new) — `withDocumentLock(documentId, fn)`**: the classic serialize-by-key
  `Map<documentId, Promise>` chain (await the prior tail — settled success OR failure — run `fn`, release
  + prune the map entry when the chain drains, all in a `finally`), made **re-entrant within one async
  call chain** via a built-in `AsyncLocalStorage<Set<string>>` (no new dependency). Re-entrancy is the
  deadlock-avoider: a lane wraps its WHOLE sequence AND calls self-locking seams inside.
- **Where it's applied:** the WRITE seams **self-lock** (thin wrappers, bodies unchanged) —
  `runBankExtraction` (incl. the `replaceExisting` DELETE+INSERT), `runBalanceValidation`,
  `runCategorization`, `runInvoiceExtraction`, `runInvoiceTotalsValidation` → **Lane B** is covered with
  ZERO dispatch edits + a future caller can't forget. The two MULTI-step lanes additionally wrap their
  whole sequence in ONE outer `withDocumentLock`: **Lane A** the bank + invoice analysis handlers,
  **Lane C** `runCategorize` (the inner self-locks become re-entrant no-ops) — needed because per-seam
  locking alone would let a re-extract slip BETWEEN a lane's own steps. READ-only/export paths
  (`runCashflowSummary`, the CSV exports, `runDocumentRedaction`) are deliberately NOT locked.
- **DELETE+INSERT atomicity:** the re-extract is already one `BEGIN…COMMIT` — the mutex serializes
  *lanes*, that txn keeps a *single* re-extract atomic; **no new DB transaction was added.**
- **No deadlock:** the doc lock is finer than `acquireChatSlot`/`ModelSlotArbiter`, `finally`-released;
  the chat lane takes the chat slot FIRST then the doc lock, and Lanes B/C never take the chat slot — no
  party holds the doc lock while waiting on the chat slot ⇒ no cycle.
- **Posture (load-bearing):** NO new DB/FS/net capability (in-memory map in the one main process; the
  workspace DB is single-writer anyway); no schema change, no IPC change; audit payload still
  `{skillId, toolName, documentCount}`; the key is an **id** (never content); nothing new is logged.
- **Tests (+3, `tests/integration/skills-concurrency.test.ts`):** (1) a re-extract + a categorize on the
  SAME document serialize — gate-audit order `[A:started, A:done, B:started, B:done]`, deterministic
  final state (one statement, categorize landed on the NEW one — no vanished-mid-read/orphans), lock map
  drains to 0; (2) two DIFFERENT docs run concurrently (both reach the barrier — a global lock would
  hang); (3) `withDocumentLock` re-entrancy (nested same-doc acquire does not deadlock). Verified test (1)
  FAILS with the lock neutered (has teeth). Privacy sentinel-grep + all skills/doctask tests stay green.
- **Docs:** `architecture.md` §9 (the per-document serialization design record), §13 (the PC-1 follow-up
  ledger entry), §22 (the D26 lanes note now records the cross-lane DB-write serialization); audit doc §3
  PC-1 row + the Phase-9 index row flipped to ✅ fixed (Phase 9) + the §2.3 diagram note + the Phase-9
  "As built" picks.
- **Eyeball:** none — a main-side concurrency phase with no UI surface (R-2 unaffected).
  **Next:** Phase 10 (X-1/X-2/A-1 — cleanup & contract parity: one `documentsInScope` helper; decide
  `count_selected_documents` (keep-as-canary vs remove); a SKILL.md ⇔ TS deterministic-answer parity test)._

_2026-06-26 — **Skills & Tools audit — Phase 8 (Zip importer DoS hardening; S-1, S-2) — MAIN-SIDE
SECURITY/PARSING PHASE (branch `skills-tools-audit-2026-06-26`).** Suite **2267 passed / 38 skipped (+3)**,
typecheck clean, build OK. Two low-effort hardening fixes to the net-new `.skill.zip` reader
(`services/skills/installer.ts`); **no renderer surface** beyond one new content-free error string.
**Load-bearing posture:** the importer gained **NO new DB/FS/net capability** — both fixes are bounds
checks on data already in hand (no schema change); and the import error path stays a **content-free
structural reason only** — neither new reason interpolates a member name/path/body, so the
`skills-ipc.test.ts` privacy sentinel-grep stays green. **As built:**
- **S-1 (MEDIUM, DoS only) — bound the inflate INPUT.** The importer used to slice + synchronously
  `inflateRawSync` a member sized by the central-directory `compressedSize` (≤ the ~8 MiB total cap; the
  cheap pre-check only sums the *spoofable* `uncompressedSize`), so a crafted member could stall the main
  thread on import. A guard at the **top of `inflateEntry`** (before `entryDataRange`/`subarray`) now
  rejects any member whose `compressedSize > maxFileBytes` — for BOTH store and deflate — **reusing
  `fileTooLarge`**. `maxOutputLength` stays the authoritative backstop against a lying *declared* size.
- **S-2 (LOW→MED) — re-validate the stripped path + reject collisions.** `stripCommonPrefix`'s output
  wasn't re-validated, and two distinct central-directory members (e.g. a duplicate name) could collapse
  to the same stripped `relPath`, where `writeStaged` is last-writer-wins → a later duplicate could
  silently shadow a preview-validated `SKILL.md`. `stageZip` now re-runs `safeRelPath` on the stripped
  path (belt-and-braces) and tracks a `Set<string>`; a colliding `relPath` throws a **new content-free
  `SKILL_IMPORT_ERRORS.duplicatePath`** code (the precise-diagnostic pick — recorded in the audit prose).
  Its three coupled edits landed: the `SKILL_IMPORT_ERRORS` entry, the `SkillsTab.tsx` `IMPORT_ERROR_KEY`
  reverse-map sibling, and the EN+DE `skills.import.error.duplicatePath` strings (parity compile-enforced;
  dev machine boots de-AT so the German renders live).
- **EOCD-first-match (S-3-adjacent).** Recorded as an **accepted low residual** in `security-model.md`
  (every enumerated member is still fully validated → hardening, not an escape); the `cdOffset+size`
  self-consistency check was deliberately **not** built.
- **Tests (+3, `tests/integration/skills-installer.test.ts`).** S-1: an incompressible 4 KiB DEFLATE
  member under a 1 KiB cap is rejected with `fileTooLarge` and a `node:zlib` `vi.mock` spy proves
  `inflateRawSync` is never reached — guarded by a **positive control** (a normal compressed import *does*
  hit the spy; spying on a default/namespace import does NOT intercept the installer's `import * as zlib`,
  hence `vi.mock`). S-2: a hand-built raw zip with two `pkg/SKILL.md` entries (JSZip can't emit duplicate
  names — added a `writeRawZip` fixture builder) is rejected with `duplicatePath`. Plus a well-formed
  multi-file package still imports. Privacy sentinel-grep + all existing import tests stay green.
- **Docs:** `architecture.md` §4 (the two DoS bounds folded into the staging design record);
  `security-model.md` "Skill-import defences" (the inflate-input bound + duplicate-collision defences +
  the EOCD-first-match accepted residual); audit doc §3 S-1/S-2 rows + the Phase-8 index row flipped to
  ✅ fixed (Phase 8), the error-code choice recorded in the Phase-8 prose.
- **Eyeball:** none — a main-side parsing/security phase with no meaningful UI surface (R-2 unaffected).
  **Next:** Phase 9 (PC-1 — cross-lane write safety: a chat re-extract `replaceExisting` DELETE racing a
  `SkillRunController` button run on the same statement; `run.ts` / `run-controller.ts`)._

_2026-06-26 — **Skills & Tools audit — Phase 7 (Suggestion discoverability; U-3) — RENDERER /
COMPOSER-FOOTER UX PHASE (branch `skills-tools-audit-2026-06-26`).** Suite **2264 passed / 38 skipped
(+4)**, typecheck clean, build OK. **AFFORDANCE DECISION = inline "Suggested: <skill>" label on the
CLOSED trigger** (the recommended quiet default; surfaced to the owner like Phases 5/6, who confirmed
it over the alternative — a bare discoverability dot that opens the picker for a two-tap apply, declined
as less discoverable and not one-tap). **Calm/privacy posture (load-bearing):** the suggestion stays an
**OFFER the user taps, never auto-applied** — no modal, no canvas chip, no settings key (§22-D3 spirit
intact); the draft is **content**, scored by the EXISTING deterministic `suggestSkills` IPC (no model,
no network) which **logs nothing** — Phase 7 introduces **no new logging/audit of the draft** and **no
new settings key / schema change**. The one new user key is EN+DE. **As built:**
- **U-3 — proactive recompute.** `ChatScreen` previously computed the offer **only** on picker-open
  (`onSkillPickerOpenChange`), so a user who never opened "Skill: none ▾" never saw a real deterministic
  asset. It now also recomputes **as the draft changes** — a new **debounced ~400 ms** effect (mirroring
  the attachment-poll/stream-flush `useRef<setTimeout>` precedent), **only when no skill is picked**,
  via `suggestSkills(conversationId, draft)`. The open-time refresh is kept. Both callers route through
  one **defensive** helper `refreshSuggestion` (`Promise.resolve(...)?.[0]` + optional chaining) so a
  stubbed/absent IPC can never throw inside the timer (this also fixed an unhandled-rejection the first
  full-suite run surfaced in `ChatAttach`/`ChatHomeNav`, where the IPC stub returns `undefined`).
- **U-3 — the closed-trigger hint.** `SkillPicker` gained a `suggestionDismissed?` prop and renders the
  offer as a quiet, named **`.skill-suggest-hint` footer button** placed right after the trigger (a
  fragment sibling, OUTSIDE the dropdown, so one tap **selects** the skill and never opens the menu). It
  shows **only when `value == null && !suggestionDismissed`**; the in-picker pinned offer is unchanged.
- **Dismissal/precedence (the care point).** `currentSkillId === null` can't distinguish an EXPLICIT
  "None" pick from a never-set default, so a renderer-side **per-draft `suggestionDismissed`** flag is
  set on `selectSkill(null)` and reset on **send** (`onSend` `setInput('')`) and on **conversation
  change** (`[activeId]` effect) — a declined offer never re-nags and never carries across conversations.
- **i18n (EN+DE, parity compile-enforced).** One new key: `chat.skill.suggestedHint` ("Suggested:
  {title}" / "Vorschlag: {title}"). The dev machine boots de-AT so the German renders live.
- **Tests (+4, `SkillChat.test.tsx`).** New "closed-trigger suggestion hint (U-3)" block: the hint
  renders WITHOUT opening + fires `onChange('user:bank')` on one tap (inert until tapped); is ABSENT
  when a skill is already selected (even with a valid offer for a different skill); is ABSENT when
  `suggestionDismissed`; CLEARS once a skill is picked. The existing pin-on-top / hide-when-active cases
  + the `suggestSkills` privacy test stay green (main-side untouched).
- **Docs:** `architecture.md` §6 (the "only inside the composer picker" line rewritten to add the
  proactive recompute + the closed-trigger hint, keeping the no-canvas-chip/no-settings-key/inert/never-
  auto-applied invariants explicit); audit doc §3 U-3 row + the Phase-7 index row flipped to ✅ fixed
  (Phase 7), the inline-label affordance recorded in the Phase-7 prose.
- **Eyeball:** the live composer-footer pixel walk of the closed-trigger hint was **deferred** (the
  `%TEMP%\paid-eyeball` harness is gone — the documented **R-2** deferral, as in Phases 5/6). Confidence
  rests on the renderer tests (hint renders/fires/clears with the right gating) + reusing the proven
  `.footer-menu-btn` affordance (only net-new style is the `.skill-suggest-hint` accent tint). **Next:**
  Phase 8 (S-1 + S-2 — zip importer DoS hardening: reject `compressedSize > maxFileBytes` before
  inflating a member; detect duplicate stripped `relPath` collisions and re-validate the stripped path)._

_2026-06-26 — **Skills & Tools audit — Phase 6 (Make the auto-categorize-on-extract explicit; U-2) —
RENDERER + MAIN UX/PRIVACY-POSTURE PHASE (branch `skills-tools-audit-2026-06-26`).** Suite **2260 passed /
38 skipped (+5)**, typecheck clean, build OK. **DECISION = (a) explicit follow-up offer** (the recommended
default; surfaced to the user before building, who confirmed (a)). **Calm/no-surprises posture (load-bearing):**
a deterministic, advertised **read-only** "Extract transactions" click must NOT silently start an LLM pass the
user didn't ask for — so the Phase-33 background auto-enqueue is **removed** and the categorize becomes a
**user-initiated** one-tap offer. Content-class boundary held: the audit payload stays `{skillId, toolName,
documentCount}`; the run state/IPC remain ids/counts-only (NO documentId in `SkillRunState`); the tool gate
gained NO new DB/FS/net capability; schema unchanged; LLM prompts stay English, the one new user key is EN+DE.
**As built:**
- **U-2 — delete the hidden enqueue.** The `extract_transactions` runner (`tool-runs.ts` `buildToolRunner`)
  used to best-effort `startDocTask({kind:'categorize'})` in the background (D26 lane, invisible in the run
  bar) once rows were extracted. That block is **gone**; the runner now just returns the extract outcome.
- **U-2 — the explicit offer.** After a successful **rows>0** extract, `SkillRunBar`'s **RESULT** row renders
  a one-tap **"Categorize transactions"** button beside Dismiss (gated `state==='done' &&
  toolName==='extract_transactions' && transactionCount>0`); tapping it calls the existing
  `onRun('categorize_transactions', false, documentId)` → `runCategorizeViaDocTask` (D26 lane unchanged). It
  is absent for a 0-row / non-extract / non-done run.
- **Same-document targeting (Phase-5 interaction).** The run state is deliberately content-free, so the offer
  can't read its target from it. `ChatScreen` remembers the launched **id** renderer-side (`runTargetId`,
  mirroring the Phase-5 `runTargetName`) and passes it to `SkillRunBar` as `runningDocumentId`; the offer rides
  that id back through `onRunTool`, so the categorize runs on the **same document** the extract did. A lost id
  (null, e.g. after a remount) ⇒ `undefined` ⇒ main's first-in-scope default. The offer copy stays content-free.
- **Opt-in paths preserved.** The deterministic **0-model-call** chat breakdown still works with NO prior
  categorize, and the existing "(D) routed feedback" effect still surfaces the per-category breakdown after any
  categorize run completes — removing the auto-enqueue did not touch either.
- **i18n (EN+DE, parity compile-enforced).** One new key: `chat.skill.run.categorizeOffer` ("Categorize
  transactions" / "Transaktionen kategorisieren"). The dev machine boots de-AT so the German renders live.
- **Tests (+5).** `SkillRunBar.test.tsx` (+3): the result-row offer renders after a rows>0 extract and fires
  `('categorize_transactions', false, 'd1')`; a lost id falls back to `undefined`; the offer is ABSENT for a
  0-row / categorize-done / extract_invoice-done / failed / cancelled run. `skills-tool-run-ipc.test.ts` (+1):
  an extract with rows enqueues **NO** `categorize` doctask (a `startDocTask` spy on the dispatch records
  zero). `doctasks-categorize.test.ts` (+1): with a fully-functional REAL doctask lane available, an extract
  leaves the lane **untouched** and the rows **uncategorized** (`category_id` all null) until an explicit
  categorize.
- **Residual.** `DocTaskManager.hasPendingKind` (the auto-offer's dedup guard) is now **unused** — left in
  place, noted for the Phase-10/X-2 cleanup (removing it is out of U-2's scope).
- **Docs:** `architecture.md` §9 (the run-UI result-row offer + `runTargetId`) and §22 (the Phase-33 "auto-offer
  after extraction" bullet rewritten to the explicit offer; the C-2/A9 "auto-offer" mentions reworded; Tests
  line gains the Phase-6 cases); audit doc §3 U-2 row + the Phase-6 index row flipped to ✅ fixed (Phase 6), the
  (a) DECISION recorded in the Phase-6 prose.
- **Eyeball:** the live run-surface pixel walk of the new offer was **deferred** (the `%TEMP%\paid-eyeball`
  harness is gone, and this is the same run surface the audit already records as an honest eyeball-deferral,
  **R-2**). Confidence rests on the renderer tests (offer renders/fires with the right id + the absent-cases
  matrix) + reusing the existing `.skill-run-bar` result-row affordance (the offer is a plain `Button`, no
  net-new CSS). **Next:** Phase 7 (U-3 — surface the deterministic skill suggestion on the CLOSED picker so a
  user who never opens it still sees the nudge; renderer phase, `ChatScreen`/`SkillPicker`)._

_2026-06-26 — **Skills & Tools audit — Phase 5 (Tool-run document targeting for multi-doc scope; U-1) —
RENDERER + UX PHASE (branch `skills-tools-audit-2026-06-26`).** Suite **2255 passed / 38 skipped (+9)**,
typecheck clean, build OK. **DECISION = Minimal** (the recommended default; the Fuller "loop over N docs"
run model stays out of scope). The **chooser UX (Radix dropdown, the DepthMenu/ScopePopover pattern)** was
surfaced to the user as a UX decision; single-doc shows the name with the chooser disabled. **Privacy note
(load-bearing):** the document **title/filename never enters `SkillRunState` / `startSkillRun` /
`getSkillRun`** — the renderer resolves the target NAME from its own already-loaded document list
(`docs`/`attachments` in `ChatScreen`); only **ids/counts** cross the IPC (the §6 posture). **As built:**
- **U-1 — surface/choose the target.** `listRunnableTools` now returns `RunnableToolSet = { tools,
  documentIds }` (the in-scope indexed ids, **content-free**, in main's `resolveInScopeDocumentIds` order —
  `[0]` = default target). `SkillRunBar` shows the single doc's name (a disabled Radix trigger) or, when
  **>1**, a Radix dropdown chooser (`menuitemradio` list, the DepthMenu pattern); the chosen id flows back
  through `onRun(tool, confirmed, documentId)`. The busy/result row names the running target from a
  renderer-remembered name (resolved at launch), falling back to the legacy count label when unknown (e.g.
  after a remount). The audit payload is **unchanged** (`{skillId, toolName, documentCount}`); `documentCount`
  stays the honest **1**; the tool gate gained NO new DB/FS/net capability.
- **Untrusted documentId.** `StartSkillRunRequest` gained an optional `documentId`; `startSkillRun`
  **re-resolves** the in-scope set and **refuses** an id not in it (`main.skills.run.documentOutOfScope`) —
  never trusting a renderer-supplied id past the scope filter. Omitted ⇒ the first in-scope doc (single-doc
  default, unchanged). No schema change (no `SkillRunState`/DB field added; the id is a request-only input).
- **Redaction routing.** The `routing` handler is now count-aware: scope > 1 ⇒ `skills.redactionRouting.answerMulti`
  ("pick which document on the **Redact** button"), still content-free (the count drives the wording; no title).
- **i18n (EN+DE, parity compile-enforced).** New keys: `chat.skill.run.runningOn` (busy row naming the doc),
  `chat.skill.run.chooseDocument` (chooser aria-label), `chat.skill.run.thisDocument` (unknown-id fallback),
  `main.skills.run.documentOutOfScope` (the refusal), `skills.redactionRouting.answerMulti`. LLM prompts stay
  English; the dev machine boots de-AT so the German copy renders live.
- **Tests (+9).** `skills-tool-run-ipc.test.ts` (+5): `documentIds` rides along + resolution order; default =
  first doc; a chosen `documentId` targets the SECOND doc (distinct count proves it); an out-of-scope id is
  **REFUSED**; and a sentinel document **TITLE** never appears in `listRunnableTools`/the run state (no-title
  assertion). `SkillRunBar.test.tsx` (+3): single-doc name shown + its id passed; multi-doc chooser selects
  the second doc's id; busy row names the target. `skills-analysis-redaction.test.ts` (+1): multi-doc routing
  uses `answerMulti`. The existing skill-import **content-class sentinel-grep** (`skills-ipc.test.ts`) still
  passes unchanged. (The existing `listRunnableTools` assertions were updated to the new `{tools,documentIds}`
  shape; the `ChatAttach` renderer stub returns the new shape.)
- **Docs:** `architecture.md` §9 (the run-UI target paragraph — renderer-side name resolution + the optional
  validated `documentId`); audit doc §3 U-1 row + the Phase-5 index row flipped to ✅ fixed (Phase 5), the
  Minimal decision recorded in the Phase-5 prose.
- **Eyeball:** the live run-surface pixel walk was **deferred** (the `%TEMP%\paid-eyeball` harness is gone, and
  a from-scratch walk needs a fully-seeded multi-doc INDEXED workspace + an enabled tool skill + a documents
  conversation — the same surface the audit already records as an honest eyeball-deferral, **R-2**). Confidence
  rests on the renderer tests (chooser select / single-doc name / busy-row naming) + the chooser reusing the
  proven `DepthMenu` Radix pattern and the existing `.footer-menu-btn`/`.menu` CSS (only net-new style is the
  `.skill-run-target` max-width/ellipsis). **Next:** Phase 6 (U-2 — make the post-extract auto-categorize an
  explicit offer, not a hidden background LLM run; a DECISION phase)._

_2026-06-26 — **Skills & Tools audit — Phase 4 (Analysis-handler performance; P-1 / P-2) — PERF PHASE, answer
text byte-identical (branch `skills-tools-audit-2026-06-26`).** Suite **2246 passed / 38 skipped (+4)**, typecheck
clean, build OK. No answer text or persisted figure changed (the rendered strings + the gold figures stay
byte-identical — the existing answer-text/audit-trio assertions pass UNCHANGED). Content-class boundary held:
the new structured `output`s (`CashflowSummary`/`ReconcileResult`/`InvoiceTotalsResult`) are figures = content and
stay **in-handler**; they are NEVER mapped into `ToolRunOutcome`/IPC (the run-bar dispatch `tool-runs.ts` still
maps counts only). Audit payload unchanged (`{skillId, toolName, documentCount}`); the tool gate gained NO new
DB/FS/net capability; no schema change; no new i18n keys. **DECISION = approach A** (recommended default — not
surfaced; it was clearly right). **As built:**
- **P-1 — single row load + seam-output reuse.** The bank handler ran each read-only tool through the seam
  (`runCashflowSummary` → reload, `runBalanceValidation` → reload) and **then recomputed** the same pure
  function over a THIRD reload (`loadStatementRowsWithCategories`) → **3 `bank_transactions` reads + 2 redundant
  recomputes** per non-category question (invoice: 2 `invoice_line_items` reads). Now the handler loads the rows
  **once** (`loadStatementRowsWithCategories`, extended to also carry `id`/`row_index`) and hands them to the
  downstream seams as a new optional `preloaded` arg (`prepareStatementRun`/`prepareInvoiceRun` skip their own
  `loadTransactions`/`loadInvoice` when supplied). The seams now **return their validated `output`** for
  in-process reuse; the handler reuses it instead of recomputing (pure-recompute fallback if a seam failed →
  byte-identical even on failure). **Result: one `bank_transactions` read (was 3); one `invoice_line_items` read
  (was 2)** — asserted by a `db.prepare` query-count spy matching `FROM bank_transactions`/`FROM
  invoice_line_items` (UPDATEs excluded, so the reconciled/category persists aren't counted).
- **P-2 — the audit-only summary no longer re-reads.** `runCashflowSummary` persists nothing, so in the analysis
  path its reload+recompute were pure overhead. KEPT the run (approach A, not B) so its `skill_run_*` trio still
  fires — the existing `skills-analysis-bank` "NEVER auto-runs export" test asserts THREE runs incl. summarize,
  and `skills-analysis-invoice` asserts TWO; both pass unchanged. The overhead is removed by REUSE: summarize
  now reuses the handler's single `preloaded` load and its `CashflowSummary` is reused, not recomputed.
- **Why A over B.** B drops the `summarize_cashflow` run → its audit trio disappears (an observable audit change
  the tests encode). A keeps the `skill_runs` lifecycle + ids/counts audit **unchanged** and still hits the
  "one read" acceptance by threading the single load into the seams. The category path keeps its one extra read
  (the reload AFTER `runCategorization` persists `category_id`) — the "one read" target is the base path.
- **Tests (+4).** `skills-run.test.ts` (+2): summarize/validate surface `output` deep-equal to
  `summarizeCashflow`/`reconcileBalances` over the rows; passing `preloaded` → **0** `bank_transactions` reads in
  the seams, same `output` as the self-loading path, and validate still persists `reconciled` `[null,1]` against
  the preloaded ids. `skills-analysis-bank.test.ts` (+1): a non-category question issues exactly **1**
  `bank_transactions` read (was 3). `skills-analysis-invoice.test.ts` (+1): exactly **1** `invoice_line_items`
  read (was 2). **Docs:** `architecture.md` §19 (single-load + seam-output-reuse paragraph) + §8 (the `preloaded`
  / `output` clause); audit doc §3 P-1/P-2 rows + the Phase-4 index row flipped to ✅ fixed (Phase 4), the
  DECISION recorded as approach A. **Next:** Phase 5 (U-1 — tool-run document targeting for multi-doc scope:
  surface/choose the target WITHOUT threading the document title into the content-free `SkillRunState`/IPC)._

_2026-06-26 — **Skills & Tools audit — Phase 3 (Bank completeness-gate numerics; C-3 / C-4) — VERSION-BUMP PHASE
(branch `skills-tools-audit-2026-06-26`).** Suite **2242 passed / 38 skipped (+5)**, typecheck clean, build OK.
Content-class boundary unchanged (audit stays `{skillId, toolName, documentCount}`; the tool gate gained NO new
DB/FS/net capability; no new user-facing copy → no i18n keys). **As built:**
- **C-3 — cent-exact completeness sum.** `assessCompleteness` (`tools/bank-statement.ts`) summed the
  `opening + Σamounts == closing` tie with a FLOAT `rows.reduce(acc + amount)` then `Math.abs(...) < MONEY_EPS`
  (0.005); over thousands of 2-dp rows the float sum can drift past half a cent and flip a genuinely-tying
  statement to a false `contradicted`. Now it sums in **integer cents** (`Math.round(amount*100)`) and compares
  `toCents(opening) + Σcents === toCents(closing)` EXACTLY — the drift-free equivalent of the old `< 0.005`
  (2-dp figures differ by whole cents). **Pure read-time computation, NOT persisted → C-3 alone needs no version
  bump.** `MONEY_EPS` is untouched (still used by `reconcileBalances`).
- **C-4 — disambiguate the dual-role `Kontostand per` label.** `KONTOSTAND_PER` ("kontostand per") was in BOTH
  `OPENING_LABELS` and `CLOSING_LABELS`, so a statement with a SINGLE `Kontostand per <date>` line read
  opening == closing → forced `contradicted`/refusal whenever rows ≠ 0. Removed it from both lists (kept in
  `BALANCE_LABELS` so `extractTransactionRows` still DROPS the summary line, no double-count) and made
  `extractStatementBalances` disambiguate by **DATE** (shared `parseDate`): two distinct-dated `Kontostand per`
  lines → earliest = opening, latest = closing; a **single** line (no pair to bracket the period) → **closing
  only** (opening undefined → the D56 gate downgrades to an honest `unverified` labelled sum, not a refusal).
  Explicit `Anfangs-/Endsaldo` labels still win where both appear. **DATA CONTRACT:** this CHANGES persisted
  `bank_statements.opening_balance/closing_balance` for affected statements → **`BANK_EXTRACTOR_VERSION` bumped
  1 → 2** (History line added in the constant's doc comment). Stale v1/NULL statements re-extract automatically
  on the next reuse via the A9 `isBankStatementStale` path (gate is `v == null || v < CURRENT`; confirmed by a
  new test). Schema is unchanged (the column is already nullable/additive from A9).
- **Tests (+5).** `skills-bank-statement-tool.test.ts` (+4): the many-row float-drift case (3000 rows of
  700000000.07, naive float drifts ~0.06 but cents tie) stays `complete` (C-3); a `Kontostand per` dated PAIR
  maps opening/closing, and a LONE line is closing-only → the statement is `unverified` not `contradicted`
  (C-4); `BANK_EXTRACTOR_VERSION === 2`. `skills-run.test.ts` (+1): a v1-stamped statement is detected stale at
  v2, a freshly-stamped one is not. The two existing `pdf-bank-layout.test.ts` Kontostand-per tests (distinct
  dated pair) pass UNCHANGED — old "first opening / last closing" and new "earliest / latest date" coincide on
  a 2-line pair; only the single-line case (uncovered before) changed.
- **GOLD-SET re-measure (gated, LOCAL — `HILBERTRAUM_PDF_GOLDSET=1`, corpus present in
  `apps/desktop/tests/real-data/corpus/`, 4 files incl. the real Raiffeisen `Umsätze - Mein ELBA.pdf`).** Ran on
  the v2 code: **3 statements measured** (1 image-only excluded), **recall micro 101.2% (86/85), macro 100%**,
  3/3 at full recall, over-extracted 1/3 (precision, pre-existing), **completeness-gate VERIFIED 1/3**, unverified
  labelled sums 1/3, **figure exact-match 100% (1/1)**, and the cardinal safety invariants **hallucinated 0 /
  partial-total 0 / model-calls 0**. No regression — the Mein ELBA Kontostand-per PAIR still reads
  opening 35.037,04 / closing 30.647,07 and ties out (VERIFIED) under v2. (This is the 3-text+1-scan aggregate
  the Phase-33 note left pending.)
- **Docs:** `architecture.md` §21 — BALANCE-LABEL GUARD bullet rewritten (Kontostand-per is date-disambiguated,
  no longer dual-listed), completeness-gate bullet gains C-3 (cent-exact) + C-4 (date disambiguation + v2 bump)
  sub-bullets, the A9 version-bump note records "now at 2", Tests line gains the Phase-3 cases. Audit doc §3
  C-3/C-4 rows + the Phase-3 index row flipped to ✅ fixed (Phase 3). **Next:** Phase 4 (analysis-handler
  performance P-1/P-2 — the read-only tools run through the seam then recompute the same pure function with
  3–4× row reloads per question; `run.ts`/`invoice-run.ts`/`analysis/*`)._

_2026-06-26 — **Skills & Tools audit — Phase 2 (Categorization correctness & consistency; C-1 / C-2 / L-1 / L-2) —
FIRST CODE-TOUCHING PHASE (branch `skills-tools-audit-2026-06-26`).** Suite **2237 passed / 38 skipped (+6)**, typecheck
clean, build OK. Content-class boundary unchanged (audit stays `{skillId, toolName, documentCount}`; the tool gate gained
NO new DB/FS/net capability; LLM prompts stay English; new user-facing copy is EN+DE). **As built:**
- **C-1 — word-boundary deterministic categorizer.** `categorizeRow` (`tools/bank-statement.ts`) matched description rules
  with a raw `desc.includes()`, so `coffee`→*Fees* (`fee`⊂`coffee`), `atmosphere`→*Cash* (`atm`), `mühlohn`→*Income*
  (`lohn`). Moved the Unicode word-boundary tester `wordIncludes` into the shared **`tools/money.ts`** (both modules already
  import it — no import cycle) and pointed BOTH `categorizeRow` and the LLM `prefilterCategory` at it, so the two paths now
  agree on every description rule. The amount-sign rule + the Spending/Uncategorized sign fallback are unchanged. **No
  `BANK_EXTRACTOR_VERSION` bump** — categories live in `bank_transactions.category_id` (re-derivable), NOT part of
  `extractor_version`; wrongly-seeded rows self-correct on the next categorize run. Trade-off (intended, already true of the
  pre-filter): a German COMPOUND that merely contains a keyword (`Kontoführungsgebühr`) no longer rule-matches deterministically
  → it goes to the model.
- **C-2 (DECISION = option A).** Two engines categorize the same statement by entry point: the chat breakdown runs the
  **deterministic** rule pass (0 model calls), while the "Categorize" button + auto-offer use the **LLM** doctask's richer
  taxonomy. **Chose option A** (keep the deterministic seed, label it honestly) over option B (route chat through the LLM
  doctask) because option B pulls a model call onto the chat-analysis path and crosses into the doctask lane — breaking the
  **load-bearing 0-model-call invariant** the §22 read-back record protects. Implemented: when `modelAssisted === false`,
  `buildBankAnswer` appends the new `skills.bankAnalysis.categoryRuleBased` note ("a quick rule-based grouping … run the
  Categorize button for a richer, model-assisted breakdown"), the mirror of the existing `categoryAssisted` note (EN + DE).
  The two entry points are no longer silently divergent.
- **L-1 — batch truncation hardening.** `batchMaxTokens` is now **length-aware** (per-row description-length allowance,
  bounded at the 160-char prompt truncation) so a verbose batch is less likely to truncate; and an **unparseable** reply
  (truncated / prose) is **retried once** before the whole batch drops to `Uncategorized` (the honest final fallback,
  unchanged). An off-list/out-of-range parsed reply is NOT retried (a deliberate drop, not a fault).
- **L-2 — bounded output.** `categorizeBatch` streamed `text += token` unbounded; now `streamBatchReply` caps the reply at
  `batchMaxTokens * 8` chars and drops the batch past it (no retry on a runaway), so a looping local runtime can't grow memory.
- **Tests (+6).** `skills-bank-statement-tool.test.ts`: `categorizeRow` word boundaries (`coffee`≠Fees, compound
  `Kontoführungsgebühr`→Spending), DE keyword as its own word still→Fees. `skills-categorizer.test.ts`: `categorizeRow`
  agrees with `prefilterCategory` on coincidental substrings; L-1 truncation-retry-then-succeed + retry-once-then-drop; L-2
  char-cap drop (not retried). `skills-analysis-bank.test.ts`: the rule-based note present when `modelAssisted` is false,
  ABSENT when model-assisted. **Docs:** `architecture.md` §8 (shared `wordIncludes`), §19 (rule-based breakdown label), §22
  (C-1 both-paths-agree + L-1/L-2 batch robustness + C-2 framing + Tests line); audit doc §3 C-1/C-2/L-1/L-2 rows + the
  Phase-2 index row flipped to ✅ fixed (Phase 2), the C-2 DECISION recorded as option A. **Next:** Phase 3 (bank
  completeness-gate numerics C-3/C-4 — version bump to 2)._

_2026-06-26 — **Skills & Tools audit — Phase 1 (Documentation truth-up; D-1 / D-2 / §16 / A-1) — DOCS ONLY, no source change
(branch `skills-tools-audit-2026-06-26`).** First remediation phase off the multi-persona Skills & Tools audit
(`docs/skills-tools-audit-2026-06-26.md`, §13 plan). Made the design docs match the shipped code; `npm test` unchanged at
**2231 passed / 38 skipped** (nothing under `src/` touched). **As built:**
- **D-1 — bundled-skill count is EIGHT, not nine.** Disk truth (`ls app-skills/*/SKILL.md`) = `bank-statement`, `invoice`,
  `document-redaction` (3 Tier-2) + `meeting-protocol`, `contract-brief`, `deadline-obligation-finder`, `what-changed`,
  `share-safe-review` (5 Tier-1) = **8**. The "nine" was a propagated miscount (4 new + 4 existing = 8); **no ninth skill was
  ever intended or committed** — count left at the real 8 (per the audit's "don't invent a ninth" guard). Fixed `architecture.md`
  DS17 ("Nine"→"Eight"; the "3 Tier-2 + the rest Tier-1" listing already summed to 8), `drive-layout.md` ("nine today"→"eight
  today"), and the two Professional-Documents-wave lines here ("four to nine"→"four to eight"). `README.md` already listed the 8
  correctly (no count word) — left as is.
- **D-2 — glob matcher is the linear `globMatches`, not the deleted `globToRegExp`.** The `>10 '*' wildcards refused` RegExp cap
  was removed at vuln-scan 2026-06-21 and replaced by a linear, non-backtracking two-pointer matcher (`selector.globMatches`, no
  wildcard cap). Rewrote the stale mentions in `architecture.md` §12 + §13 S2, `security-model.md` (the S2 follow-up para), and the
  S12-audit summary here; each now describes the linear matcher and records the removal as history. `known-limitations.md` (~L106)
  was already correct and was used as the reference wording. No surviving `globToRegExp` mention describes a live mechanism.
- **§16 localized count.** `architecture.md` §16 said "all four app skills" carry `localized.de`; all **eight** now do (verified
  `grep -l 'localized:' app-skills/*/SKILL.md` → 8) — updated to note the four Professional Documents skills extended it.
- **A-1 note.** Added one sentence to `architecture.md` §19: on the **exhaustive** analysis path the SKILL.md honesty posture is
  **code-enforced** in `buildBankAnswer`/`buildInvoiceAnswer`, not body-driven (the body shapes only the off-topic relevance
  fallback) — body⇔TS must be kept in step; a parity test is the Phase-10 follow-up.
- **Audit doc.** §3 D-1/D-2 rows + the Phase-1 index row flipped to ✅ fixed (Phase 1). **Next:** Phase 2 (categorization
  correctness C-1/C-2/L-1/L-2) — the first code-touching phase._

_2026-06-25 — **Phase 33 verification — live categorizer smoke (real model) + gold-set re-measure on the real HVB file
(branch `pdf-geometry-extraction`).** Two manual confirmations the CI suite structurally can't cover:
- **Categorizer live smoke** — new gated harness `tests/manual/categorizer-smoke.test.ts` (`HILBERTRAUM_CATEGORIZER_SMOKE=<root>`,
  optional `HILBERTRAUM_CATEGORIZER_MODEL=<path>` to skip a bad auto-pick). Ran the SHIPPING `categorizeTransactions` over 26
  synthetic transactions against a real chat GGUF (qwen3.5-4b-ud-q4kxl): **off-set categories = 0** (the json_schema enum held
  through the real llama-server — the D55 path CI never exercises, since the mock ignores `responseSchema`), the nonsense row →
  `Uncategorized` (in-set), batching crossed the 20-row boundary (2 model calls), **26/26 plausible-label agreement**, ~36s.
- **Gold-set re-measure (the pending Phase-32 item, now DONE for this file)** — assembled an off-repo corpus
  (`D:\pdf-goldset`, gitignored, D57) from the real HVB online "Umsätze" listing (Jan–Mar 2025, 45 rows, no printed balances —
  the exact file behind the Phase-32 bug) with a hand-counted `expected.json` (trueRowCount 45). `HILBERTRAUM_PDF_GOLDSET=1`
  result: **recall 100% (45/45)**, **over-extracted 0/1** (the boundary-1 `<date> <CUR> <balance>` phantom rows are GONE —
  A1/A2/A3 hold on the REAL encoding, not just synthetic fixtures), D56-R **unverified** labelled-sum path, **hallucinated /
  partial-total / model-calls all 0**. Recorded in `architecture.md` §21 (local-re-measurement note). The broader 3-text+1-scan
  aggregate still awaits a re-measure where that corpus lives. **Phase 33 is now fully verified; STILL AWAITING approval to push.**_

_2026-06-25 — **A9 stale-statement re-extraction IMPLEMENTED (Phase 31–33 follow-up #3; branch `pdf-geometry-extraction`,
still unmerged/unpushed).** The scoped fix recommended below, approved + built. A bank statement extracted under an OLD
parser no longer keeps serving stale (mis-signed / lost-payee) rows after a parser fix — the reuse paths now re-extract a
stale statement, replacing it. Suite **2231 passed / 37 skipped (+3)**, typecheck clean. **As built:**
- **Version stamp.** `BANK_EXTRACTOR_VERSION` (currently `1`) in `skills/tools/bank-statement.ts` + an additive nullable
  `bank_statements.extractor_version INTEGER` (`db.ts` `ensureColumn`). `runBankExtraction` stamps it on every insert.
  **Bump it whenever the line parser OR `pdf-layout.ts` reconstruction changes output for the same input** (history list
  is in the constant's doc comment; a pure refactor needs no bump).
- **Staleness gate.** `isBankStatementStale(db, statementId)` (exported from `run.ts`) = stored version is NULL (legacy /
  older parser) OR `<` current. Both reuse paths now re-extract when missing OR stale: the analysis read-back
  (`analysis/bank-statement.ts`) and the `categorize` doctask (`doctasks/manager.ts`).
- **Replace, not duplicate.** A re-extract passes `replaceExisting: true` → `runBankExtraction` DELETEs the document's prior
  statements (+ transactions + corrections, FK order) in the SAME persist transaction before inserting the fresh one — so
  re-extraction is atomic (a failure rolls back to the old) and never accumulates duplicate statements.
- **Categories recomputed, not carried.** The stale rows' persisted categories go with the replaced statement (the rows
  changed precisely because the parser changed them — content-key re-matching would mismatch exactly those rows). The
  breakdown's deterministic pass shows a breakdown immediately; model categorization re-runs on the next Kategorisieren /
  auto-offer. This is the honest behaviour, and keeps the analysis handler 0-model-calls.
- **Why it matters.** The sharpest silent-stale risk is the no-opening/closing "Umsätze" case: a mis-signed total degrades
  to `unverified` and is PRESENTED as a labelled sum, never caught by the D56 gate. A fresh (current-version) statement is
  still reused (no duplicate, categories preserved) — verified by a new test.
- **Tests (+3):** `skills-analysis-bank.test.ts` — stale statement re-extracted+REPLACED (one statement remains, fresh id,
  tampered figure gone), and a fresh statement REUSED (same id, no duplicate). `doctasks-categorize.test.ts` — a stale
  seeded statement is re-extracted+replaced then the corrected rows categorized; the `seedStatement` helper now stamps the
  current version (so a deliberately-fresh seed isn't treated as stale). Docs: `architecture.md` §22 (read-back bullet
  rewritten + new A9 bullet + Tests line). **STILL AWAITING approval to push / open the PR.**_

_2026-06-25 — **Code-review CLEANUP (Phase 31–33 follow-up #2; branch `pdf-geometry-extraction`, still unmerged/unpushed).**
The three contained, behaviour-neutral cleanups from the review's open list, plus an investigated recommendation for the
deeper A9 item (NOT yet implemented — awaiting decision). Suite unchanged **2228 passed / 37 skipped**, typecheck clean.
- **One `latestBankStatementId` helper (de-dup ×3).** The `SELECT id … ORDER BY created_at DESC, id DESC LIMIT 1` query
  was copied in three places; the `created_at DESC, id DESC` tie-break is LOAD-BEARING (it decides which statement gets
  categorized vs. read back, so all three MUST resolve the SAME row). Extracted as one exported helper in `skills/run.ts`
  and called from all three: the run seam (`run.ts` `prepareStatementRun`), the `categorize` doctask (`doctasks/manager.ts`
  — its private copy deleted), and the analysis read-back (`analysis/bank-statement.ts` — its local copy deleted). Picked
  `run.ts` over `tools/bank-statement.ts` because the latter is deliberately DB-handle-free ("pure main-side TS, no DB/FS").
- **One JOINed row+category read (alignment now structural).** `analysis/bank-statement.ts` queried `bank_transactions`
  TWICE with the same `ORDER BY row_index` (`loadStatementRows` + `loadPersistedCategories`) and relied on the two arrays
  lining up BY CONVENTION. Collapsed into `loadStatementRowsWithCategories` (one LEFT JOIN `bank_categories`) returning
  `RowWithCategory[]` — each row carries its own persisted category, so `categoryTotals` no longer index-matches two
  arrays. `modelAssisted` reads `paired.map(p => p.category)`; the deterministic-seed re-load reloads the paired array.
- **DocTask poll loop — DECISION: keep, documented (don't refactor).** `tool-runs.ts` `runCategorizeViaDocTask` keeps its
  60 ms status poll rather than adding an awaitable completion-promise + progress-callback channel to `DocTaskManager`.
  Rationale (in the code comment): the channel's full value (no copied loop) needs BOTH a terminal-state promise AND a
  per-tick progress callback — a completion-only promise wouldn't remove the loop (progress still mirrored). Wiring both
  touches the delicate lifecycle/abort paths (3 terminal transitions, the queued-cancel branch, the arbiter-park unwind)
  for the ONE current consumer. Revisit when a SECOND doctask-backed skill-run button would copy the loop.
- **A9 (stale statement reuse) — INVESTIGATED, recommendation below, NOT implemented (awaiting decision).** Today every
  `runBankExtraction` INSERTs a fresh `bank_statements` row (never deletes), and the analysis handler + categorize doctask
  REUSE the newest (`latestBankStatementId`) — so a document extracted under an OLD parser keeps serving stale (mis-signed
  / lost-payee) rows after a parser fix, until a manual re-extract (which today also duplicates the statement and orphans
  the persisted categories — the reason reuse is intentional). The no-opening/closing "Umsätze" case is the real risk: a
  mis-signed total degrades to `unverified` and is PRESENTED as a labelled sum, i.e. silently wrong, never caught by the
  D56 gate. **Recommendation: WORTH IT, scoped** — (1) add an additive nullable `bank_statements.extractor_version INTEGER`
  + a single `BANK_EXTRACTOR_VERSION` constant in the extractor module, stamped on insert (precedent: the `content_hash`/
  "type-set version" cache keys in `db.ts`/`tree-build.ts`); (2) in the reuse path, when the latest statement's version is
  NULL/`< current`, treat it as stale and re-extract (deterministic, 0 model calls — fits the existing "extract when none
  exists" branch), REPLACING the stale statement (delete prior statements+rows for the doc, which also stops duplicate
  accumulation); (3) do NOT content-key re-match the old categories onto the new rows — the rows changed precisely because
  the fix changed them, so the honest move is to recompute (the deterministic rule pass already runs for the breakdown;
  model categorization waits for the next Kategorisieren / auto-offer). Cost ≈ 1 column + 1 constant + a staleness branch +
  a delete-prior + tests; the fragile part (category preservation) is deliberately out. **Open question for the user:** is
  silent post-parser-fix staleness worth the manual-version-bump discipline, or is "do nothing + document the limitation"
  acceptable given parser changes are rare for end users? Awaiting the call before coding.
- **User action items recorded (local-only, NOT attempted here):** (5) re-run the gold-set harness `HILBERTRAUM_PDF_GOLDSET=1`
  on the real HVB file to confirm A3 sign handling + refresh the stale §21 numbers (measured under the old boolean gate);
  (6) D57 — confirm the exact HVB sign encoding (separate sign cell vs glued trailing minus) on the real statement. Both
  need real financial data → local only. **STILL AWAITING approval to push / open the PR.**_

_2026-06-25 — **Code-review fixes (Phase 31–33 follow-up; branch `pdf-geometry-extraction`, still unmerged/unpushed).**
A high-effort review of the 6 unpushed commits surfaced correctness bugs; the contained ones are now fixed (suite
**2228 passed / 37 skipped (+4)**, typecheck clean):
- **PDF sign handling (`pdf-layout.ts`).** (S3) A standalone `+`/`-`/`S`/`H` marker beside the running-BALANCE column
  no longer flips the AMOUNT: the fold now requires the marker to be at/right of the amount AND NEAREST the amount
  column (not a later money column). (S2) A non-folded sign token is KEPT as description text (never silently dropped)
  in reading order; only the amount's own sign cell is spliced out. (S4) `applySignMarker` now strips ALL leading/trailing
  sign decorations (`+`/`-`/`(`/`)`), so a doubly-decorated token (`(1.234,56)-`, both accepted by `MONEY_TOKEN_RE`)
  never leaves a stray `)`/`-`. New unit tests pin the balance-column-sign guard + the far-dash-as-text behaviour.
- **Categorizer prefilter word boundaries (`categorizer.ts`, P10).** `prefilterCategory` now matches on Unicode word
  boundaries, so a coincidental substring (`fee`⊂`coffee`, `atm`⊂`atmos`, `lohn`⊂`mühlohn`) no longer makes a confident
  WRONG skip-the-model match. (`categorizeRow`, the deterministic fallback, is unchanged.)
- **Model-assisted signal persisted (A8).** `runCategorize` now writes `bank_statements.categorized_by_model` (new
  additive column) = 1 whenever the LLM was consulted; the analysis read-back labels the breakdown from that
  authoritative flag (heuristic "category outside the rule set" kept only as a back-compat fallback for pre-flag
  statements). Fixes the false-negative where a model run that emitted only in-rule-set labels (Income/Transfer/Fees/Cash)
  showed NO "model-assisted" note.
- **Routed-breakdown routing (`ChatScreen.tsx`, C1/C2).** After a categorize run completes, the breakdown question is
  routed into the conversation that STARTED the run (captured in a ref) — never whatever conversation is active when the
  module-level run finishes — and under the RUN's own `skillInstallId` (not the current picker), so it can never land in
  the wrong transcript or bypass the 0-model-call bank handler. If the user navigated away it defers (surfaces on return).
- **Auto-offer dedup + zero-row guard (`tool-runs.ts`/`manager.ts`, P11).** The post-extract auto-offer enqueues a
  `'categorize'` doctask only when rows were extracted (`transactionCount > 0`) AND none is already pending for the doc
  (new `DocTaskManager.hasPendingKind`), so a re-run extract (or extract + a manual categorize) no longer queues a
  duplicate that redoes the model work and overwrites the first's labels.
- **Deliberately NOT changed (documented tradeoffs / out of scope):** an empty-description dated+amount row is still
  dropped (the intended phantom-balance kill — raw-emitting it would reintroduce phantoms); a continuation baseline with
  ANY money token is still rejected wholesale (absorbing the figure would put it BEFORE the real amount and the line
  parser would mis-read it — a verified regression, so the strict rule stays); a standalone `CHF`/`$` in a description is
  still the currency class; the latest-statement reuse has no parser-version invalidation (intentional: avoids duplicates
  + preserves persisted categories) — flagged as a future stamp if it bites. **STILL AWAITING approval to push / open the PR.**_

_2026-06-25 — **Phase 33 DONE — bank-statement LLM categorizer + the `'categorize'` doctask + the routed-breakdown UX
(branch `pdf-geometry-extraction`, still unmerged/unpushed).** Builds on the Phase-32 payee recovery (usable text to
categorize) + the D55 grammar-decoding plumbing (below). **A category is NOT a figure** — a mislabel only shifts the
per-category breakdown, never the verified statement total or the D56 gate — so the categorizer is defensible under the
honesty posture with NO `grounding_quote`/figure-verification; the constraints that hold are offline-only + fixed-set +
grammar-constrained + drop-to-`Uncategorized` + a "model-assisted" label + deterministic degrade. **As built:**
- **`services/skills/categorizer.ts`** — a fixed EN taxonomy (`CATEGORIZER_CATEGORIES`: Groceries/Dining/Transport/
  Utilities/Rent/Insurance/Subscriptions/Health/Shopping/Income/Transfer/Fees/Cash/Tax/Uncategorized; DE glosses in the
  prompt only). Confident description-rule matches (Fees/Income/Transfer/Cash) are a PRE-FILTER that skips the model; the
  rest go to the model in batches of 20 under a `json_schema` whose category field is an ENUM of the set (so the model can
  never emit an off-list label — the D55 `responseSchema`). Off-list/out-of-range/missing → `Uncategorized`; a whole batch
  drops on a parse failure. No runtime ⇒ the deterministic rule pass. Pure/MockRuntime-testable.
- **`'categorize'` DocTaskKind** (`doctasks/manager.ts` + `shared/types.ts`) — the ONE model-OPTIONAL kind (skips
  `startDocTask`'s runtime gate; null runtime ⇒ deterministic). `runCategorize` loads the latest statement, AUTO-EXTRACTS
  first when none exists (fixes the (D) `needsExtraction` ordering failure), runs the categorizer with progress+cancel, and
  persists `category_id` ATOMICALLY (reuses the now-exported `ensureBuiltinCategories`, which seeds the union of the rule
  set + the LLM taxonomy). Chosen as a doctask (not a skill-run model call) for the D26 chat↔task exclusion — verified the
  `SkillRunController`/`ModelSlotArbiter` are SEPARATE lanes that wouldn't stop two concurrent `chatStream` calls.
- **Button wiring — wrap the doctask in the skill-run shell (Q1).** The "Kategorisieren" button keeps its
  `SkillRunController` UX: `tool-runs.ts` `runCategorizeViaDocTask` ENQUEUES the doctask and mirrors progress/cancel; the
  model call runs in the doctask lane (D26-safe). `ctx.docTasks` is threaded from `registerSkillsIpc`. Without a doctask lane
  (tests/headless) it falls back to the deterministic `runCategorization` seam.
- **Auto-offer after extraction (Q2).** A successful `extract_transactions` BUTTON run best-effort enqueues a `'categorize'`
  doctask in the background (D26-safe, model-optional). The chat analysis path is unaffected (it never goes through that runner).
- **Analysis read-back stays 0-model-calls + routed feedback (Q3).** `analysis/bank-statement.ts` now REUSES the latest
  statement (re-extraction is deterministic → would only duplicate AND discard the doctask's persisted categories) and
  `categoryTotals` reads the PERSISTED category (LEFT JOIN `bank_categories`), else `categorizeRow`; it runs the deterministic
  rule pass only when nothing is categorized yet (never overwriting model categories). `modelAssisted` (a persisted category
  OUTSIDE the deterministic rule set — the honest schema-free signal) drives a "model-assisted" note. After a categorize run
  completes, `ChatScreen` ROUTES the standard breakdown question into the transcript, so the model-assisted breakdown appears
  as a normal chat answer (still 0 model calls in the handler).
- **i18n:** new DE/EN keys (`docs.task.categorizeBusy`/`Title`, `skills.bankAnalysis.categoryAssisted`,
  `chat.skill.categorize.breakdownQuestion`, the 16 `skills.bankCategory.*` display labels) — parity test green.
- **Localized category DISPLAY labels (follow-up):** the persisted identifier + the enum stay canonical
  English (so persistence + the model-assisted signal are locale-stable); only the breakdown display is
  localized via `skills.bankCategory.*` → `categoryLabel` (EN + DE). An unknown name (future user category)
  falls back to its raw identifier. Test: `skills-analysis-bank.test.ts` (DE shows "Einkommen", "Income"
  still persisted).
- **Tests:** `skills-categorizer.test.ts` (9), `doctasks-categorize.test.ts` (3 — model path, deterministic fallback,
  auto-extract-then-categorize), `skills-analysis-bank.test.ts` (+1 — persisted model categories surface + the label, no
  duplicate statement). Full suite **2224 passed / 37 skipped (+13)**, typecheck clean, production build green.
- **Honesty posture intact:** the D56 gate's three outcomes are untouched (the categorizer never feeds a figure); a
  model-assigned category is always labelled model-assisted; drop-on-failure to `Uncategorized`; never an off-set label.
- **Known v1 limitations (documented):** auto-offer fires only on the extract BUTTON, not the chat-question path
  (the chat path shows a deterministic breakdown). **STILL AWAITING approval to push / open the PR.** Per-phase ritual
  satisfied (tests + docs `architecture.md` §22 + `known-limitations.md` + this entry). **ALSO still pending (local-only):**
  run the gold-set harness on the real HVB file (`HILBERTRAUM_PDF_GOLDSET=1`) to confirm A3 sign handling + re-measure §21._

_2026-06-25 — **Runtime: grammar-constrained decoding plumbed through the chat seam (D55 prerequisite) — the foundation for the
bank LLM categorizer (Phase 33 prep; branch `pdf-geometry-extraction`).** `RuntimeChatOptions` gains an optional `responseSchema`
(+ `responseSchemaName`); `LlamaRuntime.chatStream` maps it to llama-server's OpenAI-compatible `response_format: { type:
'json_schema', json_schema: { … strict:true } }`, so a completion is GUARANTEED to be JSON matching the schema (the model cannot
emit an off-schema token). Additive + optional (the mock runtime ignores it; every existing caller is byte-unchanged) — typecheck
clean, suite unaffected. This discharges the D55 "grammar-constrained decoding plumbed through the sidecar" prerequisite the bank LLM
categorizer (user-chosen, grammar-constrained `json_schema`) needs, and that a future Stage-2 extraction would reuse.
**REFINED PLAN for the categorizer (a concrete finding from mapping D26):** the model-slot `ModelSlotArbiter` only mediates chat ↔ a
YIELDING build; the chat↔task mutual exclusion (D26) lives in the `DocTaskManager` (chat checks `hasActiveTask()`, tasks check
`isChatStreaming()`), and the skill-run `SkillRunController` is a SEPARATE one-at-a-time lane neither chat nor doctasks observe. So a
model call bolted onto `runCategorization` would NOT be D26-safe (two concurrent `chatStream` calls possible). **Therefore the LLM
categorizer must be a new `DocTaskManager` kind** (`'categorize'`) — the only lane with chat↔task exclusion, plus progress/cancel +
`getRuntime()` for free — triggered by the existing "Kategorisieren" button (its `startSkillRun` path enqueues the doctask when a
model is available; falls back to the deterministic rule pass when none is). Remaining build (Phase 33): the categorizer module
(richer EN+DE category set + the json_schema-constrained batched prompt + drop-to-Uncategorized parse), the `'categorize'` doctask
kind + renderer status wiring, the analysis handler reading PERSISTED `category_id` (LEFT JOIN `bank_categories`) with the rule
fallback, the (D) button feedback + `needsExtraction` auto-extract, tests, docs. A category is NOT a figure (a mislabel never moves
the verified total or the D56 gate), so no grounding_quote is needed — only offline + fixed-set + drop-on-failure + a "model-assisted"
label. STILL AWAITING approval to push / open the PR._

_2026-06-25 — **Bank-statement HVB "Umsätze" extraction FIXED — multi-baseline payee recovery + currency-token class +
sign-column fold + pdf.js log-noise silence (Phase 32; branch `pdf-geometry-extraction`, still unmerged/unpushed).** A real HVB
online "Umsätze" export (45 EUR rows, no printed opening/closing) surfaced three deterministic Stage-1 parsing failures the gold
set's German statements never exercised, plus a UX/log issue. **Diagnoses (all reproduced with a synthetic multi-baseline fixture,
D57 — never the real statement; confirmed line-for-line against the user's pasted symptoms):** (1) PAYEES LOST — HVB prints
payee/purpose on CONTINUATION baselines below the booking row; they orphaned onto dateless rows that `parseLine` drops, so the
description collapsed to the booking-line fragment. (2) the per-row currency code `EUR` was classed as text and polluted the
description (`… EUR`). (3) a debit's sign sits in a SEPARATE cell, so a Lastschrift read POSITIVE (`3,99` not `-3,99`). **Fixes
(deterministic, offline, 0 model calls — the D52-gated Stage-1-vs-Stage-2 call resolved as "deterministic-deeper now; Stage 2 stays
deferred", user-confirmed):**
- **A1 multi-baseline row association** (`pdf-layout.ts` `reconstructPage`, now stateful): a booking row opens a transaction; a
  following dateless, money-LESS text row is a continuation whose payee text is appended to the description (bounded by
  `MAX_CONTINUATION_ROWS`=4); flush on the next booking row / non-continuation row / page end.
- **A2 currency-token class**: a standalone ISO code/symbol is its own token class, kept out of the description and re-emitted ONCE
  after the amount (the line parser still detects currency). **This also resolves the boundary-1 over-extraction**: a phantom
  `<date> EUR <balance>` running-balance row now has an EMPTY description → dropped, while a genuine wrapped-payee row is rescued by
  A1 — exactly the objection §21 raised against a bare currency-only-description guard, now answered (A1 makes A2 safe).
- **A3 sign-column fold**: a standalone `+`/`-` or Soll/Haben `S`/`H` marker in the money-column zone (`SIGN_ZONE_SLACK`) folds into
  the amount's sign; a dash FAR from the amount is dropped but never read as a sign (conservative — can't flip a total). **Caveat
  (D57):** the exact HVB sign encoding (separate cell vs a glued trailing minus pdf.js splits) still needs confirmation on the real
  statement via the local gold-set harness; until then an unusual sign layout degrades to the honest gate, never a wrong total.
- **E pdf.js log noise**: `getDocument({ verbosity: 0 })` silences the `Warning: TT: undefined function: 21` font-program flood
  (pdf.js worker noise; real errors still surface; offline-safe).
**Tests:** `pdf-layout.test.ts` — repurposed the phantom-balance case (now DROPPED, not reconstructed) + new `HVB multi-baseline
recovery` block (currency strip, sign-column fold, conservative far-dash no-fold, association + phantom-drop). `pdf-bank-layout.test.ts`
— case (i) repurposed (phantom dropped, genuine rows tie out → verified total presented) + new case (j) (payees recovered from
continuation baselines, `EUR` stripped, Lastschrift negative → honest `unverified` sum), end-to-end through real pdf.js. Full suite
**2211 passed / 37 skipped (+5)**, typecheck clean, production build green. Docs: `architecture.md` §21 (multi-baseline-recovery
design bullet + boundary-1 rewritten as substantially RESOLVED + Tests paragraph) + `known-limitations.md` boundary (1).
- **Open follow-ups (this work's REMAINING scope, NOT done here):** (B/C) the **LLM categorizer** (user-chosen for richer German
  categories — a category is not a figure, so it is defensible under the honesty posture; needs the local-LLM/constrained-decoding
  infra, its own phase + design pass); (D) the **tool-button** feedback + the `needsExtraction`-when-clicked-before-extract ordering
  failure (`SkillRunBar`/`run.ts` `prepareStatementRun`); the A3 sign-encoding **local-harness verification** (D57). Merge prep
  unchanged — STILL AWAITING approval to push / open the PR._

_2026-06-25 — **Composer bugfix — a skill picked on the 'new' composer is no longer RESET when you upload a document
(branch `pdf-geometry-extraction`, still unmerged/unpushed).** Reported: select a skill, then attach/drop a document → the
skill silently reverts to "No skill" and must be re-picked. **Root cause (renderer, `ChatScreen.tsx`):** `attachFiles`
creates a new documents conversation and switches `activeId` to it WITHOUT carrying the selected skill, unlike
`ensureConversation` (which re-keys `skillByConv['new']`→the new id and persists the sticky default, skills plan §10.1). After
the switch, `depthKey` flips `'new'`→`conv.id`, `skillFor(conv.id)` finds nothing in `skillByConv[conv.id]` and the brand-new
conv's `activeSkillId` is null → the picker shows none. **Fix:** new `carrySkillToConversation(convId, skillId)` helper
(mirrors the ensureConversation carry); `attachFiles` captures `currentSkillId` BEFORE switching and calls it on both
new-conversation branches (empty-composer attach AND in-progress-plain-chat→new-docs-chat). A null pick needs no carry.
**Test:** new `ChatAttach.test.tsx` regression — pick a skill on the 'new' composer, drop a file, assert
`setConversationDefaultSkill('c2', 'app:bank-statement')` fires and the picker still shows the skill (fails without the fix).
Full suite **2206 passed / 37 skipped**, typecheck clean._

_2026-06-25 — **Bank-statement completeness gate REFINED — D56-R: the no-balance "Umsätze" case now answers instead of
refusing (Phase 31; branch `pdf-geometry-extraction`, still unmerged/unpushed).** Fixes the reported bug: a user opened an HVB
online "Umsätze" listing (45 EUR rows, NO printed opening/closing balance) and asked "Summiere die Ausgaben je Kategorie" — and
ALWAYS got the honest-refusal message with no total, no categories, and no way to see the rows. **Root cause (confirmed, not
re-derived):** `isStatementComplete` returned a single boolean that collapsed two very different cases — "no balance printed at
all" and "a printed balance the rows refute" — into one refusal; `buildBankAnswer` then emitted `incompleteNoTotal` for both.
**Policy refinement (D56-R, user-specified):** the gate is now THREE outcomes via the new `assessCompleteness`:
- **`complete`** — printed opening+Σ==closing ties out (+ no per-row mismatch) → present the **VERIFIED** total + proven-whole
  `caveat` (unchanged behaviour).
- **`contradicted`** — a printed balance the rows refute (per-row mismatch, OR opening+Σ ≠ closing) → keep the honest **refusal**
  (`incompleteNoTotal`, reworded to "printed balances don't add up"): a suspect read must never surface a number.
- **`unverified`** — NO opening/closing to tie against AND nothing contradicting → present the SAME totals + categories under a
  NEW `unverifiedCaveat` ("a sum of the N rows I read, **not** a verified statement total"). This is the user's case — an
  honestly-LABELLED sum is correct and useful; refusing it was over-cautious.
The cardinal D56 property is preserved exactly: a number a user could mistake for THE statement total never comes from an
incomplete read; a clearly-labelled "sum of the rows shown" is not such a number. **Plus** a bounded transaction listing (first
10 + "ask to export CSV", new `transactionsHeading`/`transactionItem`/`transactionsMore`) now trails EVERY non-empty answer
(incl. the refusal + mixed-currency branches), so "show me the transactions" is answerable. **As built:**
- `tools/bank-statement.ts`: `assessCompleteness` (+ `CompletenessStatus`); `isStatementComplete` retained as its boolean
  `=== 'complete'` projection (unit tests pin the gate by that name). `analysis/bank-statement.ts`: `buildBankAnswer` takes
  `status` not `complete`, renders the three outcomes + the listing. i18n: 4 new keys in BOTH `de.ts`+`en.ts` (parity test green).
- **Honesty tradeoff to KNOW (documented in `architecture.md` §21 + `known-limitations.md`):** for a balance-LESS statement that
  silently OVER-extracts (the deferred boundary-1 phantom running-balance rows) or UNDER-extracts (boundary-3 split amount),
  D56-R now presents an `unverified` labelled sum that is inflated/under-counted, where the OLD gate refused outright. It is
  honest per its caveat + the visible listing, but it is no longer a refusal — the maintainer's accepted tradeoff (eliminating
  the inflation itself is the still-deferred extraction fix). When the statement DOES print opening/closing, those boundaries
  still break the tie → `contradicted` → refusal (unchanged).
- **Tests:** `skills-analysis-bank.test.ts` — the no-balance `CLEAN` test repurposed (now expects the unverified total+caveat),
  a new HVB-shaped 12-row no-balance regression (totals+categories+listing+"2 more"), refusal-case listing pinned; `pdf-bank-
  layout.test.ts` case (c) repurposed (unverified sum, not refusal); `skills-bank-statement-tool.test.ts` — new
  `assessCompleteness` three-outcome block. Gold-set harness (`pdf-goldset.realdata.test.ts`, local-only/off-CI) refined to
  split VERIFIED vs UNVERIFIED totals; the cardinal `partialTotals`/`hallucinated` invariants now guard VERIFIED totals only
  (re-measure locally to refresh the §21 numbers). **Affected suites green, typecheck clean.**
- **Open:** the §21 gold-set numbers are stale (measured under the boolean gate) — flagged for a local re-measure; merge prep
  unchanged — STILL AWAITING approval to push / open the PR._

_2026-06-24 — **PDF geometry-extraction — M3 deferred-hardening addressed: CI-realism adversarial fixtures + shared-column
finding (Phase 31; branch `pdf-geometry-extraction`, still unmerged/unpushed; NO production code changed).** The pre-merge
audit's M3 had two parts: (1) a CI-realism gap (every committed geometry fixture encodes IDEAL pdf.js geometry, so a regression
that only bites on a real TextItem distribution can pass `npm test`), and (2) two deferred code fixes (boundary-3 split-amount
re-merge; boundary-1 over-extraction money-column model). **MEASURE-FIRST (D52) re-run + corpus geometry probe drove the call,
user-confirmed:** the gold set reproduces EXACTLY (micro 116.5% / 99-85, macro 100%, gate 33% (1/3), figure-exact 1/1, all safety
invariants 0; 1 image-only scan excluded). The boundary that actually OCCURS is boundary 1 (the HVB "Umsätze" page, 14→28) — but
that statement prints NO opening/closing balances, so it downgrades regardless: over-extraction costs PRECISION/UX only (count +
citations, L2), never a total or a gate pass. Boundary 3 (split amount) occurs in ZERO corpus statements (found by classifier
probing, not in the wild). **Decisive new finding:** a geometry probe of the over-extracted page showed the assumed "money-column
model" CANNOT fix boundary 1 — the per-row running balance and the transaction amount are RIGHT-aligned in ONE numeric column
(measured left-edges ~493 balance vs ~495–510 amount; every consecutive gap ≤ `DEFAULT_COLUMN_GAP` → a band-cluster merges them),
so a phantom balance row and a genuine amount row are indistinguishable by token class AND by column. The honest fix is
multi-baseline row association (harder than a column model), or Stage-2 input. **Decision (AskUserQuestion):** NO deterministic
code change (neither fix is justified by a recall/total loss); close the CI-realism gap with more adversarial SYNTHETIC fixtures;
work against the current corpus (no more real statements available). **As built (no production code touched — tests + docs only):**
- **Adversarial geometry through REAL pdf.js** — new `pdf-bank-layout.test.ts` describe block (`makeColumnarPdf`, D57-synthetic):
  sub-tolerance baseline jitter (still one row), over-tolerance jitter (amount splits off → row dropped → gate downgrades),
  tight (<12 pt) Datum/Valuta gap (columns merge → over-extraction → SAFE mixed-currency/incomplete downgrade), and the
  shared-column running-balance shape of boundary 1 (over-extraction × printed opening/closing → tie breaks → downgrade, NEVER a
  wrong total — the audit's HIGH-section stress case, now pinned end-to-end through real pdf.js, not just asserted).
- **`pdf-layout.test.ts`** — a unit test pinning the shared-column rationale (the measured money-x set forms ONE band under the gap
  rule; the phantom balance row reconstructs identically to a real amount row) so the "not a money-column model" reasoning can't rot.
- **Docs:** `architecture.md` §21 boundary-1 rewritten (money-column model disproven → multi-baseline association; safe end-to-end
  even with labelled balances) + Tests paragraph (the adversarial-geometry CI fixtures); `known-limitations.md` boundary-(1)
  corrected. **Suite 2199 passed / 37 skipped (+5)**, typecheck clean, gold-set safety invariants still **0**, 0 model calls.
- **Open follow-ups (NOT merge blockers, unchanged stance):** boundary 1 (multi-baseline association) + boundary 3 (x-adjacency
  re-merge) stay deferred — gate-safe, documented, no measured total/recall loss to justify the risk; the local-only gold set
  remains the real-DISTRIBUTION gate (keep broadening it). Merge prep unchanged — STILL AWAITING approval to push / open the PR._

_2026-06-24 — **PDF geometry-extraction — FINAL pre-merge multi-persona audit DONE + cheap findings remediated
(Phase 31; branch `pdf-geometry-extraction`, still unmerged/unpushed).** Five-persona audit written to
`docs/pdf-geometry-audit-2026-06-24.md`. **Verdict: GO for merge** — no CRITICAL/HIGH; the cardinal
data-integrity property was stress-verified (incl. the over-extraction × labelled-balance interaction:
phantom balance amounts break the `opening+Σ==closing` tie → gate downgrades, never a wrong total). Privacy
(D57: corpus gitignored/untracked/clean), D58 bank-only, and the `parseDate` non-breaking guarantee
(`money.ts` absent from the whole diff) all confirmed. **Remediated this session (suite still 2190/37,
typecheck clean, gold-set safety invariants still 0):** M1 (§21 self-contradiction "two"→"three+scan"
statements), M2 (known-limitations stale "71/71" recall → current corpus + points live numbers at §21), M4
(gold-set harness now prints an `over-extracted statements` PRECISION line + relabels "full recall"; over-
extraction reads 1/3), M5 (hallucination invariant now prints "armed over K/N presented totals w/ ground-
truth balances"), L1 (downgrade copy EN+DE no longer claims a balance MISMATCH when none was printed).
**M3 partial hardening:** investigating the deepest follow-up found a genuine THIRD Stage-1 boundary — a
pdf.js-**split amount** (`2.000` + `,00`) is never reassembled (no fragment is money; `1.234` even
back-classifies as a date) → the row is dropped (silent recall loss, still gate-safe). Now PINNED by tests
(`pdf-layout.test.ts` "Stage-1 geometry edge boundaries": split-amount drop + the `DEFAULT_ROW_TOLERANCE`=3
first-baseline anchor + the `DEFAULT_COLUMN_GAP`=12 merge; end-to-end `pdf-bank-layout.test.ts` through real
pdf.js) and DOCUMENTED as boundary (3) in §21 + known-limitations. The two tuning constants are now
regression-locked (this closes audit L3). Suite **2194 passed / 37 skipped** (+4), typecheck clean, gold-set
safety invariants still 0. **Open follow-ups (NOT merge blockers):** M3 RESIDUAL — real-PDF distributions are
still covered only by the local-only gated gold set (keep broadening + re-running it), and the deferred
x-adjacency money re-merge / money-column model; L2/L4 documented boundaries. Merge prep unchanged — STILL
AWAITING approval to push / open the PR._

_2026-06-24 — **PDF geometry-extraction — gold-set BREADTH (2 new real statements) + 2 safe boundaries found (Phase 31, D52/D57;
branch `pdf-geometry-extraction`).** Two more real statements added to the local-only gitignored corpus (D57 — never committed):
an HVB "Umsätze" page (text layer, 14 true rows) and an HVB statement the user **blacked out** to an image. Findings:
- **Gold set now (3 text + 1 scan):** micro recall **116.5% (99/85)** — >100% by design (see over-extraction below); macro 100%;
  gate pass **33% (1/3)**; figure-exact **100% (1/1)**; hallucinated/partial-total/model-calls all **0**; the 1 image-only scan
  handled safely (0 rows). Cardinal safety property holds on every statement.
- **Boundary 1 — per-row running-balance OVER-extraction (SAFE).** The HVB "Umsätze" page prints a balance row
  `<date> <CUR> <balance>` (date in the booking column) between transactions; geometry rebuilds it and `parseLine` reads the bare
  currency code as a description → a phantom transaction (14→28). SAFE: no labelled opening/closing → the D56 gate downgrades, no
  total. Proper fix = an amount/Saldo **money-column model** (analogue of `detectDatumColumn`). **DEFERRED** — a naive
  "drop currency-only description" guard was implemented then **REVERTED**: a real transaction whose description wraps to another
  baseline reconstructs as the *same* `<date> <CUR> <amount>` shape and the guard silently dropped 8 genuine HVB rows. Recorded
  as the next Stage-1 hardening step (or Stage-2 input). NO production code changed this session.
- **Boundary 2 — image-only / blacked statements (SAFE).** The blacked HVB PDF is 5 full-page images, zero text layer; Stage 1
  reads the text layer → `PdfParser` raises scan-detected → empty/downgrade (0 rows, no total, 0 model calls). OCR-path scope, not
  geometry (plan §7). The gold-set harness now tolerates the scan throw, EXCLUDES image-only statements from the recall/gate
  aggregates, and safety-asserts the empty outcome (`Expectation.imageOnly`; README schema updated).
- **As built (committed, on-branch):** harness `pdf-goldset.realdata.test.ts` (imageOnly handling + scan-leak assertion) + README;
  docs architecture.md §21 (gold-set numbers + the two boundaries + the deferred money-column fix) + known-limitations.md. Corpus
  statements + their expected.json stay gitignored. Full desktop suite **2190 passed / 37 skipped** (unchanged — gated harness +
  docs only); typecheck clean. Merge prep unchanged — STILL AWAITING approval to push / open the PR._

_2026-06-23 — **PHASE 31 CLOSED — PDF geometry-aware bank-statement extraction (Stage 1) condensed into the design record;
plan file deleted (doc-lifecycle); branch `pdf-geometry-extraction`, unmerged.** Stage 1 is the shipped extractor for the
verified layouts; Stage 2 stays DEFERRED + unapproved (D52 not closed — the gold set is too narrow). **Done this session:**
- **Synthetic BREADTH coverage (Task 1, D57 — synthetic only):** four new `makeColumnarPdf` fixtures in
  `tests/integration/pdf-bank-layout.test.ts` for layouts the two German gold-set statements don't exercise — (a) ENGLISH
  `Balance brought/carried forward` that ties out → the D56 gate PRESENTS the total in English; (b) an ENGLISH value-date
  column on a SECOND baseline → `detectDatumColumn` (density-wins) rejects it, no spurious FX row; (c) an ENGLISH
  running-balance-only statement with NO printed opening/closing → the honest gate DOWNGRADE (`incompleteNoTotal`); (d) a
  multi-line wrapped description → the booking row still extracts cleanly (the text-only continuation makes no spurious row).
  Full desktop suite **2190 passed / 37 skipped (+4)**; typecheck clean. `parseDate` untouched (§3.2); layout mode bank-only (D58).
- **DOC-LIFECYCLE close (Task 2):** condensed `docs/pdf-geometry-extraction-plan.md` into **architecture.md "Skills — design
  record" §21** (decisions D50–D58 + the facts they rest on + the design AS BUILT: the column model, the balance-label guard,
  the completeness gate, the post-fix gold-set numbers, and Stage 2 framed as a CONDITIONAL future, not a planned step). Added a
  §8 pointer to §21 and §-anchor legend rows mapping the plan's `§3.1/§3.2/§3.5 + D50–D58` (cited in code comments) to §21, so
  those comments stay resolvable without churning them. **Deleted the plan file** (full original in git history).
  `known-limitations.md` repointed at §21.
- **Gold set RE-RUN (unchanged, local-only corpus already on this machine):** recall **100% (71/71)**, gate pass **50% (1/2)**,
  figure-exact **100% (1/1)**, hallucinated/partial-total/model-calls all **0** — the breadth fixtures don't touch the corpus.
- **NEXT:** the per-phase ritual is satisfied (tests green, docs + BUILD_STATE updated, commits on-branch). Merge prep only —
  AWAITING approval to push / open the `pdf-geometry-extraction` → `master` PR. **Stage 2 is NOT built but is EXPECTED to be
  needed eventually** (recorded in architecture.md §21 + known-limitations): the 2-statement gold set is too narrow, and real
  layouts vary widely (no-printed-balance statements, ruled/borderless tables, scans) so deterministic geometry will likely
  miss some — treat Stage 2 as a PROBABLE future need, gated not abandoned. Still measure-then-build: broaden the gold-set
  corpus (more banks/layouts) and re-run the harness; Stage 2 lands once Stage-1 recall drops < ~90% on a layout the gate
  cannot honestly downgrade (and carries the D55 grammar-decoding plumbing as real prerequisite work)._

_2026-06-23 — **PDF geometry-extraction — Stage-1 PRECISION FIX (column model + balance-label guard) closes the Raiffeisen
over-extraction (Phase 31, D52/D56/D57; branch `pdf-geometry-extraction`).** The first gold-set measurement (entry below) found
Stage 1 OVER-extracting the full Raiffeisen "Mein ELBA" statement to 43 rows so the D56 gate could not present a total, even though the
statement ties out. Root cause: `reconstructLine` classified tokens by regex with NO column model, so (a) the Valuta/value-date column —
printed on a SECOND baseline aligned with a row's second description line, with a foreign-currency reference amount (`39,00 USD`) hidden in
that line — was emitted as a spurious transaction, and (b) the `Kontostand per <date>` opening/closing lines were mis-read as transactions.
**As built (typecheck + full suite green, 2186 passed / 37 skipped, +9 tests):**
- **`pdf-layout.ts` booking-date column model** — `detectDatumColumn` clusters every date token's x into bands and picks the DENSEST,
  leftmost (the booking column prints one date per row; density-first guards against a stray header/period date further left). `rowTokens`
  now carries each token's x; `reconstructLine(row, year, datum)` qualifies a row ONLY when its lead date sits in that column — a Valuta or
  mid-line date no longer makes a transaction. The non-transaction RAW fallback also DROPS out-of-column date tokens, so a Valuta line whose
  leftmost token is a full value-date can't be RE-EXTRACTED by the date-leading `parseLine`. `parseDate` untouched (§3.2); `datum`
  null/omitted keeps legacy behaviour for direct unit calls.
- **`bank-statement.ts` balance-label guard** — `'kontostand per'` added to BOTH `OPENING_LABELS` and `CLOSING_LABELS` (the existing
  first-opening/last-closing rule then reads opening `35.037,04` from the `per 31.03` line and closing `30.647,07` from the `per 23.06`
  line; "Aktueller Kontostand" deliberately NOT added — it restates the closing at the top and would corrupt the opening). New
  `isBalanceLabelLine` makes `extractTransactionRows` SKIP any balance-label line: in the real layout the `Kontostand per` date sits IN the
  Datum column, so geometry alone can't reject it — but a balance line is a summary, never a transaction (it is still read by
  `extractStatementBalances`). This stops the double-count that broke the tie.
- **Synthetic regression (D57 — never a real statement):** `pdf-bank-layout.test.ts` extended with a Raiffeisen-shaped `makeColumnarPdf`
  fixture (Valuta date on a second baseline + FX reference amount in the description; `Kontostand per` pseudo-rows with the date IN the Datum
  column) — asserts exactly the real rows extract, balances are found, and the gate presents the correct total; plus a non-tying variant that
  must still downgrade. `pdf-layout.test.ts` adds `detectDatumColumn` + out-of-column-date unit coverage.
- **GOLD SET RE-RUN (local-only, the real HVB + Raiffeisen corpus already on this machine):** micro recall **123.9% → 100.0% (71/71)**,
  macro 100%, full-recall 2/2, **gate pass 0% → 50% (1/2** — Raiffeisen now presents the total; the HVB excerpt with no printed balances
  correctly downgrades**)**, **figure-exact-match 100% (1/1)**, hallucinated 0 / partial-total 0 / model-calls 0. **D52 NOT yet closed:** two
  statements is strong but narrow evidence; still need breadth (Sparkasse/ING/DKB + invoices) before declaring Stage 1 sufficient and
  condensing the plan into architecture.md §8. Stage 2 remains unbuilt and unapproved._

_2026-06-23 — **PDF geometry-extraction — gold-set measurement harness landed + FIRST real measurement (Phase 31, D52/D57; branch
`pdf-geometry-extraction`).** New LOCAL-ONLY, gitignored, gated harness `apps/desktop/tests/real-data/pdf-goldset.realdata.test.ts`
(+README) runs real statements through the ACTUAL Stage-1 path (`PdfParser.parse({layout:true,maxPages})` → `bankStatementAnalysisHandler`)
and prints AGGREGATE metrics only — ZERO model calls. Gated behind `HILBERTRAUM_PDF_GOLDSET=1` via `describe.runIf` (COLLECTED →
FullSuiteGuard-safe, skipped in `npm test`; suite now 2177 passed / 37 skipped). Corpus = `$HILBERTRAUM_PDF_GOLDSET_DIR` else gitignored
`tests/real-data/corpus/` (`<name>.pdf` + `<name>.expected.json`; `.gitignore` updated — real statements are user financial data, NEVER
committed, D57). Recall + figure-exact-match are LOGGED (the D52 input); hallucinated-figure / partial-total-presented (D56) / model-calls
are HARD-ASSERTED == 0. **First real datapoint:** the MOTIVATING sanitized HVB statement (Umsätze web export, pages 2–7, 45 columnar
transactions — the exact shape that used to return ZERO) now extracts **45/45 rows = 100% recall, 0 model calls**, all D56 safety invariants
0. Gate pass 0% is CORRECT for that file (a transactions-only excerpt with no printed opening/closing balance → honest D56 downgrade, no
total). **NOT enough to close D52 yet:** one statement, and it only exercises the gate's DOWNGRADE path. Still needed before the D52 call:
(a) breadth across banks (Sparkasse/ING/DKB + invoices) for recall confidence, and (b) ≥1 FULL statement WITH printed Alter/Neuer Kontostand
(opening/closing) + those figures in its `expected.json` to exercise the gate PASS path and yield a real figure-exact-match number. Stage-1
behavior UNCHANGED this session (measurement only)._

_2026-06-23 — **PDF geometry-aware extraction — Stage 1 SHIPPED (Phase 31, D50–D58; branch `pdf-geometry-extraction`).** Fixes the
real user report: a German HVB bank statement analysed with `app:bank-statement` returned ZERO transactions because the PDF parser
DISCARDED the word coordinates pdf.js already fetches, so a columnar statement (date · description · amount, year in the page header)
arrived as scrambled reading-order text and almost no row survived the line-oriented `parseLine`. **As built (typecheck + build clean;
full suite 2177 passed / 36 skipped, +~40 tests):**
- **New `ingestion/parsers/pdf-layout.ts`** — pure/offline geometry reconstruction: cluster words into visual rows by baseline `y`,
  classify tokens (date / money / text), resolve the page-header YEAR and emit a full `DD.MM.YYYY` date so the SHARED `parseDate` is
  **untouched** (§3.2 — invoice + redaction non-breaking guarantee), DROP the value-date column so it can't be misread as the amount,
  and emit every visual row (transactions year-resolved; other rows raw so opening/closing-balance labels + currency survive). No new
  dependency (D50).
- **`ParseContext.layout`** + `PdfParser` layout mode (keeps the coordinates it used to discard; scan-detection re-keyed on RAW text so
  an empty reconstruction is never mistaken for an image-only scan; page cap honored on the layout path).
- **Bank-only wiring through the EXISTING re-parse seam (D51/D58):** `extractDocumentPreview` opts → `readDocumentSegments(id, {layout})`
  → `resolveDocumentReader`/`BankExtractionDeps.layout` → the bank analysis handler + the doc-action runner set `layout:true`; the IPC
  closure threads the page cap. **Redaction, invoice, ingest, the renderer preview, translate, and compare are byte-unchanged** (they
  never set `layout`).
- **Completeness gate (D56 — the cardinal safety property):** new `extractStatementBalances` (printed opening/closing balances, EN+DE
  labels) + `isStatementComplete` (`opening + Σamounts == closing` within half a cent AND no per-row mismatch — the per-row chain alone is
  necessary-not-sufficient). Persisted on `bank_statements` (additive nullable `opening_balance`/`closing_balance`). `buildBankAnswer`
  presents a single-currency total ONLY when proven complete; otherwise it **downgrades** to an honest "couldn't confirm the whole
  statement" message (new `skills.bankAnalysis.incompleteNoTotal`, EN+DE) — never a partial sum dressed up as a total. Mixed-currency
  still reports no-single-total (safe; no total presented).
- **DATA CONTRACT additions:** `ExtractTransactionsOutput.openingBalance?`/`closingBalance?` (+ schema); `bank_statements.opening_balance`/
  `closing_balance` (REAL, nullable, CONTENT-CLASS — never logged/audited/exported); `readDocumentSegments` signature now
  `(id, opts?:{layout?})`.
- **Tests:** `pdf-layout.test.ts` (clustering, year→full-date, value-date drop, balance-line preservation); bank-statement tool unit tests
  (`extractStatementBalances`, `isStatementComplete`); `pdf-bank-layout.test.ts` integration — a SYNTHETIC columnar PDF (new
  `makeColumnarPdf` fixture builder, zero new deps, WinAnsi umlauts) proving text-mode loses every row while layout-mode recovers all
  three + correct total + honest coverage + citations + **0 model calls**, plus a non-tying-balance fixture that MUST downgrade;
  `resolveDocumentReader` seam test (layout threaded only when requested, D58); existing bank fixtures (handler + IPC) updated to carry
  tying opening/closing balances where a total is asserted. **Docs:** plan header marked Stage-1-shipped (file KEPT — Stage 2 still open);
  `known-limitations.md` updated.
- **NEXT — Stage 2 is NOT built (deliberately, D52):** the §4 constrained local-LLM fallback (+ its D55 grammar/`json_schema` runtime
  plumbing over `llama-server`) lands ONLY if Stage-1 deterministic recall on the **local-only** gold set (D57 — real statements, gitignored,
  `PAID_*`-style manual harness; never committed) proves below ~90%. Measure first, then decide. The gold-set harness itself is not yet
  written. Real German layouts beyond the synthetic fixture are UNVERIFIED until that harness runs._

_2026-06-22 — **Skill finetuning Wave 3 — real-model harness (autonomous stand-in for the GUI smoke test).** The vitest suite proves
the Wave-3 LOGIC against the mock runtime; this proves real-model OUTPUT QUALITY without a GUI or workspace access. New
**`tests/real-model/wave3.realmodel.test.ts`** drives the ACTUAL whole-doc / compare / tree code with a real local llama.cpp model
from the portable drive: it builds the app's runtime via `createSelectingRuntimeFactory` (CPU rung, the dev `HILBERTRAUM_LLAMA_BIN`
override → `D:/runtime/llama.cpp/win/llama-server.exe`) + a model from `D:/models/chat`, ingests inline fixtures with the MOCK embedder
(the whole-doc/compare/tree paths read chunks in ORDER, not by embedding — only the CHAT model is real), and calls
`generateGroundedAnswer({ wholeDocument | wholeDocumentCompare })` + `answerWholeDocFromTree`. **GATED** behind
`HILBERTRAUM_REAL_MODEL=1` via `describe.runIf` — COLLECTED (FullSuiteGuard-safe) but skipped in the normal suite (no model spawn). Run:
`HILBERTRAUM_REAL_MODEL=1 npx vitest run tests/real-model/wave3.realmodel.test.ts` (just German: append `-t German`; PowerShell:
`$env:HILBERTRAUM_REAL_MODEL=1; …`). Two describes (**English** + **German**) share one model load via a top-level `beforeAll`.
**Verified 2026-06-22 with qwen3.5-4b (CPU, ctx 8192), all 6 green (EN+DE):** in BOTH languages the Wave 2 minutes carried the
END-of-transcript items (Prometheus→Q3, Dana→Friday/Freitag) at `capped` coverage and a full sectioned format; the compare surfaced the
LATE changes (Berlin→Frankfurt, conf 3→5y/Jahre, liability 12→6m/Monate) with `[S1]`+`[S2]` proving both whole versions were read; the
tree reduce returned `tree` coverage. The German doc+question are answered in German even though the SKILL.md fence stays English
(the system prompt's "answer in the document's language" holds). No new dependency (no `cross-env`); fully offline._

_2026-06-22 — **Skill finetuning Wave 3, Phase 4 (Follow-up B): 2-document whole-doc compare for `what-changed`.** Wave 2 left
`what-changed` on the relevance/top-k path (it was single-doc). Now a compare-shaped request over EXACTLY TWO in-scope docs feeds
BOTH documents whole (budget-aware) with the SKILL.md fence, so the compare is material-change analysis over full versions, not top-k.
**Budget split (user-confirmed = size-aware with redistribution):** each doc gets up to HALF the whole-doc budget; a smaller doc
donates its unused half to the larger one — so two versions that jointly fit are both read WHOLE (the common case), two large versions
each get ~half, and a large+small pair gives the large doc the slack. **As built (typecheck + build clean; full suite green, +12
tests):** new handler mode **`grounded-whole-doc-compare`** + **`whatChangedAnalysisHandler`** (compare keywords EN+DE, `applies()` =
exactly-two-in-scope-docs); registered for `app:what-changed`. `registerRagIpc` detects the mode (after the same D45 fully-chunked
refusal, now gating BOTH docs) and calls `generateGroundedAnswer({ wholeDocumentCompare:{ documentIds } })`. New in `rag/index.ts`:
**`splitCompareBudget`** (pure), **`retrieveCompareWholeDocuments`** (both docs read in order, **continuous `[Sn]` labels** across the
two so a citation names its version — M2), **`buildCompareWholeDocPrompt`** (labelled "Document 1/2" blocks + the fence). Coverage is
honest **`capped`** (`truncated` when EITHER doc overflowed its share); a 1-/3-doc scope keeps the relevance path byte-unchanged. §14
ceiling + fence/guard bracketing unchanged. **Docs:** `architecture.md` §20 (compare record + Tests), `known-limitations.md` updated.
**Tests:** `rag-whole-doc-compare.test.ts` (IPC: both whole docs in one labelled turn + capped coverage + cross-doc citations; refuse
when a doc isn't fully chunked; single-doc keeps relevance); `skills-analysis-whole-doc.test.ts` extended (handler shape + applies +
`splitCompareBudget` + `retrieveCompareWholeDocuments`). **NEXT: none outstanding from the Wave-3 brief — remaining follow-up is a
tree-backed compare (apply Phase-3 map-reduce per oversized doc inside the 2-doc compare), documented in §20 but not yet built._

_2026-06-22 — **Skill finetuning Wave 3, Phase 3 (Follow-up A): deep-index map-reduce for an over-budget whole-doc skill turn.**
Wave 2 read an over-budget document from the BEGINNING and stamped the honest `capped`/"covers the beginning" badge — coverage
stopped at the budget. This closes that for a document with a **ready deep-index tree**: instead of truncating, run the SAME map-reduce
the tree summary uses (`manager.summarizeFromTree`) over the precomputed node summaries with the SKILL.md fence applied at EVERY step,
and stamp honest `tree` coverage. **As built (typecheck + build clean; full suite green, +3 tests):** new
**`rag/whole-doc-tree.ts` → `answerWholeDocFromTree`**. `generateGroundedAnswer` detects `retrieveWholeDocument`'s `truncated` flag
and hands off; the function reads the **deepest layer** (`nodeSummariesAtLevel(level 1)` = full leaf coverage) → `packIntoWindows` →
a skill-fenced **MAP** per window (when >1) → a skill-fenced **streamed REDUCE** (when summaries fit one window the single fenced
reduce IS the step). Coverage `{ mode:'tree', treeStatus:'ready', chunksCovered=reachableLeafChunkIds, chunksTotal, treeLevels,
truncated:false }`; citations = **leaf chunks** (`documentLeafProvenance`, M2-safe). Returns **null** when no usable tree (no `ready`
status / no node summaries) → caller keeps the byte-unchanged Wave 2 capped path; after a model call it always returns a Message
(answer, or empty on Stop) so a cancel never triggers a second capped pass. A doc that FITS the budget never enters this branch
(`truncated:false`) — small-doc path byte-identical to Wave 2. **Reuses** the existing tree/coverage/summary infra (no parallel one);
§14 ceiling unchanged (pure DB reads + chat runtime); the fence+guard bracket the untrusted body in every step's USER turn, app
system prompt outside. **Docs:** `architecture.md` §20 (record + Tests), `known-limitations.md` updated. **Tests:**
`rag-whole-doc-tree.test.ts` (single-level → 1 fenced reduce + tree coverage + leaf citations + skill stamp; multi-level + small
context → map-per-section then reduce with the fence at every step; no-ready-tree → null + no model call). **NEXT (Phase 4 / Follow-up
B): 2-document whole-doc compare for `what-changed` — confirm the budget split across the two docs with the user before implementing._

_2026-06-22 — **Skill finetuning Wave 3, Phase 2: strip echoed skill-fence framing from model answers.** The Wave 2 smoke test
showed a model reproducing the fence's closing delimiter — a trailing `--- END LOCAL SKILL ---` — verbatim in its minutes. The skill
fence brackets the untrusted SKILL.md body with fixed English framing + the guard line (§11.2/§14); the model copying a delimiter into
the answer is cosmetic noise, never intended output. **As built (typecheck + build clean; full suite 2131 passed / 30 skipped, +4
tests):** new pure `stripSkillFenceEcho(content)` in `skills/prompt.ts` removes any line whose trimmed form exactly equals an
app-authored framing constant (`FENCE_BEGIN`/`FENCE_END`/`SCOPE_LINE`/`INSTRUCTIONS_LABEL`/`SKILL_GUARD_LINE`) — NOT the dynamic
"Skill name: <title>" line. It is a **no-op when no framing line is present**, so non-skill answers and clean skill answers stay
byte-identical; only a detected echo triggers cleanup (drop the lines, collapse the blank run a removed delimiter leaves, trim the
ends). Wired right after `stripThinkBlocks` on BOTH model paths — plain chat (`chat.ts`) and grounded/whole-doc (`rag/index.ts`) — the
same place reasoning is scrubbed. Tests: `skills-prompt.test.ts` (+4 — trailing delimiter, all framing lines, no-op byte-identity,
title-line preserved). **NEXT: Follow-up A (deep-index map-reduce for oversized whole-doc) + B (2-doc whole-doc compare for
what-changed)._

_2026-06-22 — **Skill finetuning Wave 3, Phase 1: attach-flow scope handoff fix (real-app smoke-test defect).** The Wave 2
smoke test surfaced a real bug while reaching the whole-doc engine: unchecking Library on the 'new' composer, then attaching a
document via the paper-clip, RE-CHECKED Library — so the turn stayed whole-Library, retrieval pulled an unrelated library doc
(a Nolus-whitepaper chunk leaked into meeting minutes), `singleInScopeDocument` saw many docs, and `grounded-whole-doc` never
fired (the relevance path ran, with the skill fence applied → the 8-section format WITHOUT whole-doc coverage). **Root cause:**
`ChatScreen.attachFiles` created the new documents conversation via `createConversation({ mode: 'documents' })` — dropping the
user's `pendingScope`, unlike `createConversationInMode` which carries it. The fresh conversation defaulted to the Library anchor.
**As built (typecheck clean; ChatAttach renderer tests green, +1):** new `createDocsConversationForAttach()` helper mirrors
`createConversationInMode`'s pending-scope handoff (passes `scope` + the single-project `collectionId`, then clears `pendingScope`);
both new-conversation branches in `attachFiles` use it. **This also makes Wave 2 reachable from a paper-clip attachment with no
file-naming:** with the empty-Library scope preserved, `resolveScope` unions the lone attachment into `documentIds` and drops the
(empty) collection set → exactly one in-scope doc → whole-doc engine fires. Existing two attach assertions updated for the new call
shape (`scope:null, collectionId:undefined` on the no-pending path — behaviour-preserving: main serializes null scope to NULL
`scope_v2_json` = the prior Library default). **NEXT (Phase 2): strip the echoed `--- END LOCAL SKILL ---` fence delimiter from
model output; then Follow-up A (deep-index map-reduce for oversized whole-doc) + B (2-doc whole-doc compare for what-changed)._

_2026-06-22 — **Skill finetuning Wave 2: skill-aware whole-document engine for the Tier-1 instruction skills.** Closes the
structural gap the Wave 1 audit found — the SKILL.md fence is applied on ONLY the top-k relevance engine, so the instruction skills
(meeting-protocol, contract-brief, share-safe-review, deadline-obligation-finder) could be whole-document OR formatted-to-spec, never
both (worst: minutes from ~5 passages miss decisions/actions). **As built (typecheck + build clean; full suite 2126 passed / 30
skipped, +27 tests):**
- **New `grounded-whole-doc` handler mode** (third after `exhaustive` + `routing`; `run()` is now optional — these handlers omit it).
  `registerRagIpc` detects the mode and streams a MODEL answer via **`generateGroundedAnswer({ wholeDocument:{ documentId } })`**
  instead of calling `run()`. The §19 D45 fully-chunked **refusal** still gates the turn (a not-fully-chunked doc → refuse, no model).
- **New `retrieveWholeDocument(db, docId, budget)`** in `rag/index.ts` — loads a single document's chunks **in order** (not top-k),
  capped to `wholeDocumentBudgetTokens` (real window − answer reserve − system − question − fence allowance), labelled `[S1]…[Sn]`,
  with an honest `truncated` flag. `generateGroundedAnswer` now branches on `opts.wholeDocument`, applies the SKILL.md fence exactly as
  the relevance path, and persists **`coverage:{ mode:'capped', truncated }`** → the existing meter wording ("covers the whole document"
  / "covers the beginning"). Relevance path byte-unchanged (coverage stays NULL ⇒ relevance badge).
- **New `analysis/whole-doc-skills.ts`** — the four handlers register `grounded-whole-doc` + `applies()` (analysis-shaped keywords EN+DE
  over a SINGLE in-scope doc). Keyword sets include the bare domain nouns (e.g. `contract`/`vertrag`) since `includes` can't span
  "summarize **this** contract" and the skills are explicitly selected. **`what-changed` stays on the compare/relevance path** (inherently
  multi-document — out of Wave 2 scope).
- **KNOWN LIMIT (documented):** an over-budget document is read from the **beginning** with the honest "covers the beginning" badge — never
  silently complete. Deep-index map-reduce for oversized docs + a 2-doc whole-doc compare for `what-changed` are the follow-ups.
- **Docs:** folded into `architecture.md` **§20** (plan `docs/skill-whole-doc-engine-plan.md` deleted); `known-limitations.md` updated.
  **Tests:** `skills-analysis-whole-doc.test.ts` (handlers + `retrieveWholeDocument`), `rag-whole-doc-skill.test.ts` (IPC: model called +
  capped coverage + fence + whole transcript in the user turn; refuse path; off-topic keeps relevance)._

_2026-06-22 — **Skill finetuning Wave 1: document-redaction routing handler (test-found UX defect).** Testing "Can you anonymize the doc
please?" with a document + the redaction skill selected surfaced two defects, both rooted in one design choice (D49: redaction kept the top-k
relevance path): (1) the model wrote a **lecture/refusal** — reciting the SKILL.md caveats ("you never run it yourself", everything it won't
catch) and inventing a manual procedure instead of pointing at the one-click run button — and even **speculated about the document's content**
from the retrieved passages; (2) the coverage footer read **"Basiert auf den relevantesten Passagen — nicht auf dem ganzen Dokument"**, which
is misleading because the `redact_document` tool reads the **whole** document. **As built (typecheck clean; 666 skills/rag/chat/whole-doc tests
green, +10 new):**
- **New `mode: 'exhaustive' | 'routing'` on `SkillAnalysisHandler`** (default `exhaustive`). A **`routing`** handler reads NO content, runs NO
  tool, emits NO audit event. `SkillAnalysisResult.coverage` is now **optional** (omitted by routing). Architecture record: §19 **D49a**.
- **New `analysis/redaction.ts`** — `document-redaction` now **registers** a routing handler (reversing D49's "never registers"). `applies()` =
  redaction-shaped verbs (EN+DE: anonymize/redact/schwärzen/…) + ≥1 in-scope doc. `run()` returns a deterministic, localized answer naming the
  **same** run button the SkillRunBar shows (`chat.skill.tool.redactDocument`), with **empty citations** → the renderer shows **no coverage
  badge** (`CoverageMeter` renders only when an answer has citations — `Transcript.tsx:238`). No model call.
- **`registerRagIpc`** skips the D45 fully-chunked **refusal** for a `routing` handler (nothing is read, so full chunking is irrelevant).
- **SKILL.md body rewritten** so the **first paragraph** (the one the prompt builder guarantees to keep — `prompt.ts buildSkillFence`) is the
  action-routing instruction ("click the **Redact personal data** button… never state whether the document does/doesn't contain personal
  data"); honesty caveats demoted. This fixes the **fallback** path (an off-topic turn where the model still answers).
- The write tool stays **user-initiated + confirm-gated** — routing points at it, never runs it. **New i18n:** `skills.redactionRouting.answer`
  (EN+DE). **Tests:** new `skills-analysis-redaction.test.ts` (applies/run/registry/no-tool-run/no-coverage); bank+invoice tests updated for the
  now-optional `coverage`.
- **NEXT (Wave 2, user-approved direction = skill-aware whole-doc engine "A"):** the four Tier-1 **instruction** skills (meeting-protocol,
  contract-brief, share-safe-review, deadline-obligation-finder) are **analysis** skills that want whole-document coverage but hit a structural
  gap — the SKILL.md fence is honored ONLY on the top-k relevance engine; every whole-document engine (tree-summary, coverage-extract,
  analysis handlers) ignores it. So they can be whole-document OR formatted-to-spec, never both (worst: meeting-protocol — minutes from top-k
  miss decisions/actions, and "summarize meeting" can hijack to a generic tree-summary). **DONE in Wave 2 (above) — see `architecture.md` §20.**_

_2026-06-22 — **Image analysis survives navigation + content-free lifecycle logging (two test-found bugs).** Found while testing:
(1) starting a picture analysis, navigating to another screen, and returning showed an idle screen — the running analysis was invisible
(Chat already recovers its in-flight stream); (2) a started analysis left NO trace in the log. **As built (full suite green — 2087 passed /
30 skipped, +1 test; typecheck + build clean):**
- **New `renderer/lib/visionSession.ts` store** — the active analysis (loaded image + Q&A thread + live answer) + the `onImage*` stream
  listeners now live in a **module-level store** (the `doctasks.ts`/`skillruns.ts` "survives screen unmount" precedent), NOT in
  `ImagesScreen`. `ImagesScreen` reads it via `useSyncExternalStore` and keeps only screen-local concerns (availability, composer draft,
  history list, transient errors). Because the store owns the in-flight job, navigating away **no longer cancels it** (removed the
  unmount→`imageCancel` effect); on return the screen re-renders the image + the still-streaming partial answer, lossless (the listeners
  kept firing into the store). No main-side recovery/snapshot needed — unlike Chat's `getActiveStream`, the decoded image is renderer-only,
  so keeping listeners alive in the store is both simpler and lossless. Workspace **LOCK** calls `clearVisionSession()` so resident
  image/answer content is dropped in lockstep with main purging the job map (privacy parity).
- **Content-free lifecycle logs** in `services/vision/index.ts`: `Vision analyze started` (on accept) + `Vision analyze done` (on success),
  `{jobId}` only — never image/prompt/answer. The existing `Vision analyze failed` warn (raw reason → local log) is unchanged, so the
  security sentinel (`vision-security.test.ts`) stays green.
- **List vs detail view (same wave, second report).** A finished analysis used to STRAND the user on the result view (couldn't upload a
  new picture). `ImagesScreen` now has a screen-local `viewingDetail` (default **list**): the landing **list** = upload drop zone +
  previous-results history; the **detail** = preview + composer + thread with a "‹ Back to analyses" link that leaves WITHOUT cancelling.
  `viewingDetail` is per-mount, so navigating back to Images always returns to the new-analysis view. **While an analysis runs**: the upload
  (drop zone + picker) is **disabled** (vision is one-at-a-time) with a hint, and the in-flight job is a distinct **"Analysis running…"** top
  row of the results list (`ImageHistory`'s new `running` prop — no DB row yet, so clicking re-opens the live detail view from the store).
- **Tests/docs:** `ImagesScreen.test.tsx` — "survives navigation" now asserts remount lands on the LIST with a running row + disabled upload,
  clicking it opens the live stream; new "Back returns to the list (analysis keeps running) without cancelling"; store reset between renderer
  tests (`resetVisionSessionForTests`). New i18n keys `images.drop.busy`/`images.back`/`images.history.running`/`runningOpen` (EN+DE).
  `architecture.md` image-understanding record §5 (Renderer) + §7 (privacy posture) updated._

_2026-06-22 — **Images screen: Copy fix + history-row redesign (third test report).** (1) **Copy answer** did nothing — `ImagesScreen.onCopy`
used `navigator.clipboard.writeText`, which the file://-loaded renderer denies (`clipboard-sanitized-write` permission-request WARN in the
log). Now routes through MAIN via `window.api.copyToClipboard` (clipboard:write), exactly like `ChatScreen.onCopyMessage`. +1 regression test
(Copy → `copyToClipboard` called with the answer text). (2) **Verlauf (history) rows redesigned** in `ImageHistory.tsx` + `styles.css`: each row
is now a surface card (shadow, accent border on hover) with a picture-glyph icon tile, a name/meta text column (question count **·** localized
date — `formatDate`, the count wrapped in its own span so the exact-text test still matches), and a quieter ghost **Delete** that turns to the
error tone on hover/focus. The "Analysis running…" row reuses the same shape (accent-tinted). Full suite green — 2089 passed / 30 skipped._

_2026-06-22 — **Two alignment nits (CSS-only).** (1) Images `Verlauf`/history list dropped its `max-width` so it spans the same full width as
the upload drop zone above it (both fill the `.images-screen` column). (2) Chat `.skill-run-bar` (the Tier-2 tool OFFER/RUN row, e.g. the
"Personenbezogene Daten schwärzen" tag above the composer) now shares the centered **720px conversation column** (`max-width:720px; margin:0
auto`) like the composer + transcript — it was flush-left against the full `chat-main` width, so the offer chip sat left of the composer box.
Build clean._

_2026-06-21 — **Professional Documents skills wave — Meeting Minutes upgrade + four new Tier-1 instruction skills (SKILLS-ONLY,
no runtime/schema/tool/network change).** The bundled `app-skills/` set grew from four to **eight** (four new + the four existing), all honest, calm, document-grounded
workflows with bilingual (EN+DE) triggers and German `localized.de` display metadata. **As built (suite green — 2083 passed / 30 skipped,
+19 tests; typecheck clean):**
- **`meeting-protocol` upgraded in place → titled *Meeting Minutes* (id UNCHANGED for backward compat; version 1.0.0 → 1.1.0).**
  Expanded the instruction body to the 8-section structure (summary · context · topics · decisions table · action-items table · open
  questions · risks · formal version), added formal-motion/vote handling (only when the source uses motion language), and broadened the
  bilingual keyword set. Kept the "Separate what was decided from what was merely discussed" line the existing integration test pins.
- **Four NEW Tier-1 instruction skills** (`kind: instruction`, `allowedTools: []`, `reservesTools: false`, v1 permission ceiling):
  `contract-brief` (Vertragsübersicht — plain-language brief, explicitly *not* legal advice), `deadline-obligation-finder`
  (Fristen & Pflichten — deadlines/obligations, "not a complete compliance calendar"), `what-changed` (Was hat sich geändert? — version
  compare, "select exactly two documents"), `share-safe-review` (Sicher teilen prüfen — advisory pre-share review; warns about hidden
  metadata + scans/OCR, points at the redaction *tool* but declares no tool and creates nothing; never "fully anonymized"/GDPR claims).
- **Trigger precision.** High-precision, multi-word bilingual keywords + umlaut/plural pairs; the pure redaction verbs
  (anonymize/schwärzen/redact) are deliberately LEFT to `document-redaction` so an "anonymize this" turn still suggests the redaction
  tool, not the share-safe advisory. No cross-fire (meeting/invoice questions never suggest contract review). **Post-audit fixes:**
  dropped the deadline keyword `termine` (substring-matches the common English word "deter**mine**") and tightened `what-changed`'s
  filename patterns to version-markers only (`*redline*`, `*-v1*`, `*_v2*`, `*draft*`, …) — the bare generics `*final*`/`*new*`/`*old*`/
  `*version*` cleared the mime+filename suggest bar on very common unrelated files. Added the deadline stem `frist` (covers
  `befristet`/`fristlos`/`Fristverlängerung` and tips the `kündigungsfrist` tie from Contract Brief → Deadline finder). Kept contract's
  `agb` keyword (rare "Schlagball" collision, accepted like the pre-existing `bill`/"Bill" precision ceiling in the S13a corpus). +3
  regression tests (Kündigungsfrist→deadline; tightened what-changed filenames don't auto-fire on `final-report.pdf`; version-marked
  file still offers something) — suite now +22 tests overall. The S13a auto-fire eval
  harness loads only the original four candidates, so its threshold-3 100%-precision gate is unaffected; the expanded meeting keywords add
  no ≥3 wrong fire on the corpus.
- **Tests:** new `skills-professional-documents.test.ts` (19 tests): all five parse as valid bundled skills, the four new ones are
  instruction/no-tools/German-localized, `meeting-protocol` id stays stable + title is *Meeting Minutes*, EN+DE triggers fire the right
  skill on the REAL selector, redaction request still → `document-redaction`, neutral/ambiguous inputs fire nothing. Existing
  `skills-meeting-protocol` / `skills-suggest` / `skill-triggers` (eval gate) stay green.
- **Docs:** `user-guide.md` §9 gained a "Professional Documents" subsection; `architecture.md` DS17 + `drive-layout.md` skills note now
  say eight bundled skills; `README.md` tree comment updated. **Caveat/follow-up:** these are SUGGEST-only (no `autoFire` opt-in — only
  `document-redaction` declares it); the auto-fire eval corpus + `APP_SKILL_IDS` still cover only the original four, so the new skills'
  suggestion precision is asserted by the new targeted tests, not the synthetic corpus sweep._

_2026-06-21 — **Vuln-scan remediation — item B: re-hash sidecar binaries before spawn (the LAST open finding; scan now FULLY
remediated).** The tracked TOCTOU (= audit-2026-06-14 "engine-binary not re-hashed before spawn"): `llama-server` / `whisper-cli` /
the `--list-devices` GPU probe were SHA-256-verified at install but NOT re-hashed before `spawn`, so a local adversary overwriting
`runtime/<family>/<os>/<bin>` between install and launch got code-exec. The spawns are arg-array (no shell) so the residual was
purely the missing re-verification. **As built (suite green — 2062 passed / 30 skipped, +19 tests; typecheck clean), coherent commits:**
- **Install marker now records each binary's own SHA-256.** `RuntimeInstallMarker` gained optional `binaries: Record<relPath,sha256>`
  (`assets.ts`), keyed by the binary's path relative to the extract dir, posix `/` (`markerBinaryKey`). `readRuntimeMarker` parses it
  **tolerantly** (malformed → dropped; hash-less marker still deep-equals the legacy shape). Written by ALL three marker writers: the
  in-app installer (`runtime-download.ts`, best-effort hash of `plan.binaryPath`) + the DIY `fetch-runtime.{ps1,sh}` scripts.
- **One shared, session-cached verifier** (`binary-verifier.ts`): `verifyBinaryBeforeSpawn(binPath)` → `ok|skip-legacy|skip-dev|mismatch`.
  Walks UP from the binary's dir to the nearest marker (covers the `cpu/` safety-net), re-hashes, compares; **cached per resolved path**
  (the probe + start race the same path). Unreadable binary fails SAFE (`mismatch`). `initBinaryVerification(isDev)` once in `index.ts`:
  **packaged enforces, dev skips**; a binary with a recorded hash is verified, one WITHOUT (legacy/un-upgraded drive) is TOLERATED
  (`skip-legacy`, never refuses). Inert before init → headless unit suite unaffected.
- **Wired at the spawn seams (a `mismatch` only fires packaged):** `LlamaServer.start()` (`sidecar.ts`) **throws before port/child**
  → ladder falls to next rung / **MockRuntime** (covers chat + embedder + reranker + vision — all funnel through `start()`); GPU probe
  (`gpu.ts`) resolves **`[]`** (never throws); whisper `run()` (`cli.ts`) **refuses** → per-file friendly failure. Dev-only
  `HILBERTRAUM_*_BIN` overrides are NOT hash-gated (dev → skip).
- **Commercial sell-gate** (`commercial-drive.ts`): `assertCommercialDrive` now REQUIRES the marker hash present + matching the on-disk
  binary — a drive built by a pre-B `fetch-runtime`, or a binary modified after install, **fails the gate** (forces rebuild).
- **Tests:** new `binary-verifier.test.ts` (markerKey, matrix match/mismatch/missing-hash/no-marker/unreadable/cpu-walk-up, gate +
  session-cache); sidecar/gpu/whisper tamper-refusal; assets marker round-trip WITH hashes + malformed-`binaries` drop; engine-download
  asserts the install writes the hash; commercial-drive no-hash + post-install-tamper fail the gate. **Docs:** `security-model.md`
  DEFERRED section → as-built design record; M-5 forward-ref updated; `known-limitations.md` residual (pre-B DIY drives unprotected
  until rebuilt). **ITEM B DONE → the .deepsec vuln-scan 2026-06-21 is now FULLY remediated** (Tier-1 + HIGH_BUG + option C + option D + B).
**Follow-up (post-audit robustness):** the pre-spawn verifier no longer session-caches a TRANSIENT read failure.
`computeRawVerification` distinguishes `unreadable` (couldn't hash — e.g. a Windows AV/indexer lock) from a real
hash `mismatch` (tamper); both still fail safe THIS spawn, but `verifyBinaryBeforeSpawn` evicts an `unreadable`
result from the cache (identity-guarded) so the next spawn re-hashes — a self-healing lock no longer strands the
session on MockRuntime, while a real tamper verdict stays sticky. +2 tests in `binary-verifier.test.ts`
(unreadable-then-recover, tamper-stays-cached). Suite still green.
**(Option D entry below.)**_

_2026-06-21 — **Vuln-scan remediation — defense-in-depth / least-privilege gaps (option D).** The four MEDIUM items that are
deviations from the app's own trust model (renderer = UNTRUSTED; threat #1 = code-exec'd renderer). Confirmed two IPC-contract
choices with the user: **D1 = picker token + harden drag-drop**, **D2 = opaque token**. **As built (suite green — 2043 passed /
30 skipped; typecheck clean), one coherent commit each:**
- **D1 — `importDocuments` bound to a picker capability token** (`registerDocsIpc.ts`, `shared/types.ts`, preload, ChatScreen +
  DocumentsScreen, `docs-ipc.test.ts`). Raw renderer paths were a confused-deputy arbitrary-file read (text reachable via
  preview/export/RAG). `pickDocuments` now returns `{ token, paths }` (one-time `randomUUID`, bounded map, single-use, bound to
  the OS-vetted paths); a PICKER import passes `options.pickerToken` and main **resolves+consumes it, ignoring the renderer
  `paths`**. Forged/replayed/unknown token ⇒ imports nothing. **Drag-drop residual (accepted, documented):** an OS drop is
  delivered to the *renderer* (untokenizable) — that seam still passes raw paths but is hardened (`lstat`-reject symlink →
  `realpathSync`); no network exfil sink exists. `importPreflight` stays on raw paths (counts/sizes, lower impact). 4 regression
  tests (token binding, forged-token, single-use, drop symlink-reject).
- **D2 — `imageReadBytes` takes an opaque token, never a path** (`registerImagesIpc.ts`, preload, ImagesScreen, `images-ipc.test.ts`).
  `imageChooseImage` now returns `{ token, name, sizeBytes }` (path stays in main, bounded one-time map); `imageReadBytes(token)`
  resolves+consumes and reads via **open→fstat→read on one fd** (cap authoritative; closes the `stat`→`read` TOCTOU). Closes the
  `.png`-named-symlink / arbitrary-read vector. 3 new tests (non-token path refused, single-use, choose returns no `path`).
- **D3 — `downloadToFile` per-hop redirect re-validation + body cap** (`assets.ts`, `downloads.ts`, `assets.test.ts`). Was
  `redirect:'follow'` with TLS checked only on the initial URL → SSRF to LAN/loopback (`169.254.169.254`), https→http downgrade,
  and unbounded disk-fill. Now `redirect:'manual'`; each hop (initial + every `Location`) re-checked by `assertSafeDownloadUrl`
  (**https-only + loopback/private-range deny** + max-redirect cap), and the body is capped at min{`Content-Length`, caller
  `maxBytes`}+margin (model downloader passes the manifest size) with a global backstop. All seam users (weights/runtime/OCR)
  inherit it. 5 new tests (follow-public, http-downgrade reject, private-host reject, redirect-loop, size-cap).
- **D4 — vision guard bounds decoded pixels, not just bytes** (`vision/limits.ts`, `vision-limits.test.ts`). A <20 MiB
  decompression-bomb PNG/JPEG decoded to billions of px and OOM'd the sidecar (runtime.ts inlines the ORIGINAL bytes; the
  renderer `MAX_DIMENSION` is display-only). `validateAnalyzeRequest` now parses the **header** (PNG IHDR / JPEG SOF) for
  `width*height` — no full decode — and rejects above `VISION_MAX_IMAGE_PIXELS` (~50 MP default, `HILBERTRAUM_MAX_IMAGE_PIXELS`)
  as `tooLarge`; unknown dims fall through to the byte cap. New `tests/unit/vision-limits.test.ts` (8 cases incl. PNG/JPEG bombs).
**Docs:** `security-model.md` gains a "Least-privilege hardening of the renderer↔main file/network seams" §-section (D1–D4).
**OPTION D COMPLETE.** **STILL OPEN:** B — sidecar re-hash-before-spawn (DEFERRED; design in `security-model.md`). That is the
only remaining triaged item from this scan.
**(Option C entry below.)**_

_2026-06-21 — **Vuln-scan remediation, Tier 2 — robustness BUGs (option C).** Working the report's 8 BUG-severity items
(one, the malformed-manifest `buildModelList` crash, was already closed in Tier 1). Each is a robustness/correctness defect,
not an attacker-reachable vulnerability; fixed as small coherent commits with regression tests. **Closed so far:**
- **`analysis/coverage.ts` `reachableLeafChunkIds` cyclic-tree guard.** The iterative DFS tracked a `seen` set only for leaf
  CHUNK ids; node→node edges recursed unconditionally, so a cycle (DB corruption / a future builder bug) would overflow the stack
  and crash the coverage read. Now tracks visited NODE ids (seeded with the root) and skips already-visited nodes. buildTree still
  writes a strictly acyclic tree, so this is purely defensive. Test: whole-doc-analysis injects a node→root back-edge and asserts
  the walk terminates with leaf coverage intact.
- **`audit.ts` `listAuditEvents` pagination cursor.** A supplied `beforeId` whose anchor row was pruned (retention) fell through
  to the newest page, so a client paging toward older events looped / showed duplicates. Now returns an EMPTY page (terminates
  pagination); the Diagnostics "earlier" button hides cleanly (`page.length === PAGE_SIZE` ⇒ false). Doc comment + the existing
  audit.test pagination test updated to the new contract.
- **Vision service cluster (`vision/index.ts`, `vision/history.ts`, `vision/runtime.ts`, `registerImagesIpc.ts`).** Four items,
  one commit: (1) **residue-after-lock (MEDIUM)** — `VisionService.stop()` (wired to lock/quit) now CLEARS the job map +
  controllers after teardown, so a completed answer (content from the private image) doesn't survive the vault re-encrypt;
  (2) **unbounded job map (BUG)** — terminal jobs are evicted past `VISION_MAX_JOB_HISTORY=16`; (3) **history read-temp collision
  (BUG)** — the decrypt temp is now per-call unique (`<id>.read-<pid>-<uuid>.tmp`) so two concurrent reads of one session can't
  interleave/shred each other; (4) **`imageGetJob`/`imageCancel` gated on `requireUnlocked`** (consistent with imageAnalyze +
  history handlers); plus a stale `startFailed` "Cleared by stop()" comment corrected (it's intentionally sticky — a stopped
  runtime is discarded). Tests: 3 new in `vision-security.test.ts` (stop() purges the answer, the map is bounded, locked handlers
  reject). Docs: `security-model.md` "Encrypted image-analysis history" gains the unique-read-temp + lock-residue-purge notes.
- **`downloads.ts` `start()` single-flight TOCTOU (BUG).** The `activeJob()` guard and the `this.active` assignment straddled
  `await planModelDownloads(...)`, so two near-simultaneous `start()` invokes both passed the guard → two concurrent runs, and the
  second overwrote `this.active`, orphaning the FIRST job's AbortController (an un-cancellable download). Added a synchronous
  `starting` latch set right after the guard and cleared in a `finally` (by which point `this.active` is set), so the second
  invoke rejects with `alreadyRunning`. Verified before/never-trust boundary is untouched (the garbled `.part` still fails SHA-256).
  Test: two un-awaited `start()`s in one tick — the second rejects, exactly one active job remains.
- **`workspace-vault.ts` `applyPendingRekey` partial-failure resilience (BUG).** Post-commit (the in-memory key already swapped
  to the new data key), the swap loop threw on the FIRST sidecar rename failure (e.g. a transiently locked file on Windows),
  abandoning every LATER staged sidecar under the RETIRED key → many documents decrypted to a GCM-tag failure mid-session until
  `recoverPendingRekey` finished them on the next unlock. Now best-effort + one retry pass: attempt all files, retry the
  stragglers, and only then throw — so at most a genuinely-stuck file is deferred to recovery, never the whole tail. Idempotent /
  crash-safe contract unchanged. Test: a staged sidecar whose target is a non-empty dir (forced rename failure) — the other
  sidecars still swap; the stuck one stays staged.
**OPTION C COMPLETE** — all 7 remaining robustness BUGs fixed (the 8th, malformed-manifest list crash, closed in Tier 1).
**NEXT (asked of user):** B sidecar re-hash-before-spawn / D defense-in-depth gaps.
**(Tier-2 HIGH_BUG entry below; Tier-1 entry under that.)**_

_2026-06-21 — **Vuln-scan remediation, Tier 2 — the HIGH_BUG: summary-tree build could loop forever / block the doc-task queue.**
`analysis/tree-build.ts` `buildTree()` reduces a document's summary tree level-by-level in a `for(;;)` that halts only when a
level collapses to one root group. `groupByBudget` never splits an over-budget child, and the loop relied on the (FALSE-at-small-
budget) assumption that a node summary is "far below a group budget". `summaryBudgetWords` floors at 200 words but a node summary is
capped at `SUMMARY_OUTPUT_TOKENS`(512), so at a low `contextTokens` (renderer-controlled, previously **unvalidated for a minimum**)
every node summary exceeded a budget window → each sat alone → the upper levels never reduced → **infinite loop issuing unbounded
`generate()` calls; `tree_status` stuck `building`; and since `DocTaskManager.pump()` only advances when `runningId` clears, the
WHOLE single-slot doc-task queue (summary/translate/compare/ocr/extract) permanently blocked.** **As built (suite green — 2018 passed
/ 30 skipped; typecheck clean):**
- **Provable termination, independent of model output size.** `groupByBudget(children, budgetWords, minPerGroup=1)` gains a
  minimum-branching lever; the **node-reduction levels (≥2) pass `minPerGroup=2`**, so a group is flushed only once it holds ≥2
  children and every level bar a final remainder strictly shrinks — the build halts in ≤`leaves.length` levels no matter how large
  the summaries are. **Level 1 (chunks→summaries) keeps `minPerGroup=1`** (it may legitimately be 1:1 — a 500-tok chunk exceeds a
  small budget — but it runs exactly once; the reduction happens at the node levels above). A backstop guard throws
  `TREE_BUILD_NO_PROGRESS` (+ a `maxLevels = leaves.length+1` cap) if a node level ever fails to shrink, turning a would-be hang into
  a clean task failure (run() → generic-failure copy, raw to local log only; doc left resumable `building`).
- **`contextTokens` floor.** `updateSettings` (settings.ts) now clamps `contextTokens` **UP** to `MIN_CONTEXT_TOKENS=2048` (clamps,
  never drops; non-finite → floor) so a buggy/hostile renderer patch can't starve the budget below a single summary's size. 2048
  always fits ≥2 node summaries + the prompt/output reserve in one reduce window. (Renderer reaches it via the generic `settings:update`
  IPC; the Settings screen only displays the value.)
- **Tests + docs.** New regression `whole-doc-analysis.test.ts` → "tree build termination": direct `buildTree` at `contextTokens:1024`
  with a model emitting 400-word (>budget) summaries now **completes** (ready, full leaf coverage, bounded calls) — it would hang
  before the fix. New `db-settings.test.ts` clamp test (512/1024→2048, 8192 passthrough, NaN→floor). `password-change.test.ts`
  persistence-marker values raised above the floor (777/1234 were arbitrary markers, now 8192/3072). Design record folded into
  `rag-design.md` §14.3 ("Provable termination").
**NEXT (asked of user):** B sidecar re-hash-before-spawn / C the 8 robustness BUGs / D defense-in-depth gaps.
**(prior Tier-1 entry below.)**_

_2026-06-21 — **Vuln-scan remediation, Tier 1 (true-positive security; ReDoS + extraction + manifest hardening).**
Worked the `.deepsec/.../report.md` scan (28 findings; many scanner-confirmed false positives). This pass fixed the
**attacker-reachable** items — the rest are triaged below. **As built (suite green — 2016 passed / 30 skipped; typecheck clean):**
- **Parsing-DoS → made provably LINEAR (threat #1: resource exhaustion while parsing a hostile document/skill).** Three
  synchronous main-process regexes backtracked super-linearly: `skills/tools/money.ts` `MONEY_RE` (shared by bank-statement +
  invoice; `\d[\d.,]*` → bounded `\d[\d.,]{0,30}`, and `\s*`→`\s{0,4}`), `skills/tools/redaction.ts` `EMAIL_RE`
  (local/domain bounded to RFC 64/255), and `skills/selector.ts` (glob→RegExp **replaced** by a linear two-pointer
  `globMatches` — the old `*`-only wildcard cap let `*?*?…` through). Token/parse behaviour unchanged for realistic input;
  added 200k-char "< 1 s" regression tests to bank-statement/redaction/selector suites.
- **Engine extractor pins an ABSOLUTE `tar`** (`runtime-download.ts` `resolveTarBinary`) — a bare `spawn('tar')` let a
  CWD-planted `tar.exe` hijack the interpreter on Windows ([rce]). Falls back to the bare name only on an exotic host; spawns
  with a controlled `cwd`. New `resolveTarBinary` unit tests (win/posix/fallback).
- **Hostile manifest can no longer break the whole Models list** — `validateManifest` now rejects an absolute/`..`
  `local_path`/`mmproj.local_path` (so `discoverManifests` records+skips it), AND `buildModelList`'s loop wraps
  `computeInstallState` in try/catch (one bad manifest → an errored entry, not a dead Models screen). `weightPath` keeps its own
  runtime guard. Tests added to `manifest.test.ts`; `models.test.ts` weightPath-guard test rebuilt to bypass validation.
**DEFERRED (documented, not fixed):** the sidecar **re-hash-before-spawn** TOCTOU (`llama-server`/`whisper-cli`/GPU probe) —
no per-binary hash is recorded today (marker has version/backend only), it needs cross-language script sync, and a non-breaking
"verify-when-present" rollout; design + rollout written into `security-model.md` ("Open item: re-hash sidecar binaries before
spawn"). Other lower-tier items (importDocuments/imageReadBytes renderer-path trust, downloadToFile redirect SSRF, vision
job-map residue/leak, decompression-bomb dimension cap, and the 8 robustness BUGs) remain open per the user's "Tier 1 first" scope.
**Docs:** `security-model.md` gains four §-sections (parsing-DoS, absolute-`tar`, manifest-list, the deferred re-hash design);
`known-limitations.md` glob-ReDoS note updated (linear matcher, not a wildcard cap). **Verification:** `npm test` 2016 passed /
30 skipped; `npm run typecheck` clean.
**(prior V8 entry below.)**_

_2026-06-20 — **Image-understanding V8 — answer markdown FIXED + encrypted, deletable analysis HISTORY added (user-requested).**
Two user-reported gaps on the Images screen. **(1) Formatting:** the streamed answer rendered raw markdown (literal `**bold**`, `1.`
lists). `AnswerThread` now renders through the SAME shared `AssistantMarkdown` (`react-markdown` + `remark-gfm`) Chat/Documents use — the
`.image-turn-text.md` container reuses the existing `.msg-content.md` rules; the stream caret is a sibling of the markdown block.
**(2) History (the headline change — INTENTIONALLY reverses the V1–V5 "nothing persists" posture):** each analyzed image is now AUTOMATICALLY
saved (image + Q&A turns), browsable like documents/chat, and **deleting an entry shreds the stored image**; everything rests **encrypted at
rest** under the same `DocumentCipher` as the document cache. Decisions confirmed with the user: **automatic save** (lazily on the first
completed answer — no turnless sessions) + a **text-row history list** (no thumbnails; the image is only decrypted when an entry is opened).
**As built (suite green — 2003 passed / 30 skipped):**
- **Schema (`db.ts`):** new `image_sessions` (`title`, `stored_name` [relative], `mime_type`, `size_bytes`, `width`/`height`, `encrypted`,
  timestamps) + `image_turns` (`session_id` FK **ON DELETE CASCADE**, `question`, `answer`, `created_at`). Additive (`IF NOT EXISTS`).
- **Service (`services/vision/history.ts`):** mirrors the document cache — `imagesDir()`, `createImageSession` (encrypt-to-`.enc` via a
  shred-after temp, or raw copy in plaintext mode), `addImageTurn`, `listImageSessions` (newest-first; `turn_count` + first question;
  `rowid`-ordered to dodge ms-tie nondeterminism), `getImageSession` (decrypt-to-temp → read → shred), `deleteImageSession` (shred + cascade).
- **IPC/preload:** `images:listSessions|getSession|deleteSession` (all `requireUnlocked()`); `imageAnalyze` creates the session lazily in the
  `done` wrapper + persists the turn, surfacing `sessionId` on the initial job AND the `STREAM.imgDone` event so follow-ups reuse the session.
  `ImageAnalyzeRequest` gained `name`/`width`/`height`/`sessionId`; `ImageJob` gained `sessionId`; new `ImageSessionSummary`/`Detail` DTOs.
- **UI:** `renderer/images/ImageHistory.tsx` (text-row list under the drop zone; delete via `ConfirmDialog`); `ImagesScreen` loads the list on
  unlock, opens an entry (decrypt → replay turns → continue asking same session), and refreshes on save/delete. `images.history.*` keys (EN+DE).
- **Security test re-aimed:** `vision-security.test.ts` TEST-3's "writes nothing to disk" guarantee was **deliberately replaced** by "the
  stored copy rests ENCRYPTED under `images/` (no plaintext image bytes on disk)"; loopback-only + no-content-in-log/audit are unchanged.
**Data contracts (new):** `image_sessions`/`image_turns` tables; `images/<id><ext>.enc` (or raw `<id><ext>` in plaintext_dev) under workspace;
the three `images:*Session(s)` IPCs. **Docs:** `architecture.md` image-understanding record gains **§10** (history); `security-model.md` gains
an "Encrypted image-analysis history" section; `drive-layout.md` adds `workspace/images/`. **Verification:** `npm run typecheck` clean;
`npm test` **2003 passed / 30 skipped**. New/updated tests: `image-history.test.ts` (encrypted no-leak + round-trip + cascade-delete shred),
`images-ipc.test.ts` history-persistence block (persist-on-done, follow-up append, busy persists nothing, list/get/delete, locked reject),
`vision-security.test.ts` (encrypted-at-rest), `AnswerThread.test.tsx` (markdown), `ImagesScreen.test.tsx` (history list/open/delete).
**(prior V7 entry below.)**_

_2026-06-20 — **Image-understanding V7 — first `role: vision` manifest shipped + the three in-app vision gaps it exposed CLOSED.**
A user tried the Images screen with no vision model, so the **Qwen2.5-VL-3B-Instruct Q4 + f16 mmproj** manifest was authored into the
catalog (`model-manifests/vision/qwen2.5-vl-3b-instruct-q4.yaml`, Apache-2.0, opt-in: `recommended_profiles: []`/rank 0, real GGUF+mmproj
hashes from `model-policy.md`). That made vision discoverable + downloadable in-app for the first time — which exercised three paths the
V6 entry had marked latent/residual. **As built (suite green):**
- **DIST-1 in-app residual CLOSED — `downloads.ts` now fetches ALL of a model's files, not just `tasks[0]`.** `DownloadManager.start()`
  plans every task, gates the model-level license once, and downloads each file that is absent/stale under ONE job; a model whose GGUF is
  already present+verified but whose mmproj is missing fetches JUST the projector (the user's exact half-installed case). `run()` became a
  sequential orchestrator over a new per-file `runOne()` with COMBINED received/total (`sumSizes` helper, null-safe → Content-Length
  refines mid-run); the job is `done` only when every file verifies, and one placeholder hash taints the whole model UNVERIFIED. Tests:
  `downloads.test.ts` "DownloadManager vision (two files)" — both-files, finish-a-partial, fully-present-refused.
- **Models-screen vision card FIXED — vision is now availability-driven (`automatic`), like the embedder.** It was wrongly treated as a
  chat model and showed Select/Start, which throw for a non-`chat` role (`registerModelIpc`). Added `vision` to the `automatic` set (no
  Select/Start, no Active badge) + a vision-specific hint `models.vision.installed/notInstalled` (EN+DE) pointing at the Images tab.
  Download-before-install + Installed-after still correct. Tests added in `ModelsScreen.test.tsx` (missing + installed vision cards).
- **Progress-bar height bug FIXED (unrelated, same session).** `.download-progress progress { flex: 1 1 160px }` was written for a row
  flex child, but the `Progress` component wraps `<progress>` in a `flex-direction: column` `.progress`, so `flex-basis: 160px` became the
  bar HEIGHT (~160px tall). Dropped the obsolete rule; `.progress progress` now `height: 8px` (consistent across download/verify/engine bars).
**Docs:** `architecture.md` image-understanding design record updated — the "Download topology" row, the rejected "one job, two files"
alternative, and the DIST-1 "Residual" paragraph now record the in-app downloader as multi-file (the residual is closed). **Verification:**
`npm run typecheck` clean; the touched suites green (downloads incl. 3 new vision cases, ModelsScreen incl. 2 new, vision-status,
GermanSmoke, models, commercial-drive). The installed vision card was eyeball-verified via an Electron screenshot of the real component DOM
against the real CSS. **Note:** weights are NOT committed (§0) — the user downloads them in-app; the GGUF+mmproj live on their D: drive only.
**(prior V6 entry below — its "in-app DownloadManager remains single-file for vision" residual is now resolved.)**_

_2026-06-20 — **Image-understanding V6 — pre-merge audit remediation SHIPPED (the V5 audit `docs/image-understanding-audit-2026-06-20-v5.md`).**
Branch `image-understanding`. The V5 audit verdict was "safe to merge, no CRITICAL, no active HIGH"; this entry closes the two LATENT
HIGHs + the MEDIUM/LOW/NIT quality gaps so the branch is clean before a real vision drive ships. **No §0 redline touched; suite green
with zero vision models. As built:**
- **DIST-1 (HIGH, latent) — the download side now fetches BOTH files of a vision model.** `assets.ts` `planModelDownloads` emits a SECOND
  `ModelDownloadTask` (same `modelId`) from `manifest.mmproj.download → mmproj.local_path`, verified against `mmproj.sha256` (the "two
  DownloadJobs sharing one modelId" topology, plan §8.3) — factored through a shared `planOneFile` so the GGUF + projector share one
  license-gate/present-verified state machine. `scripts/fetch-models.{sh,ps1}` taught the same: a block-scoped `mmproj:` parse + a
  per-file `handle_file`/`Invoke-HandleFile` that mirrors the atomic `.part`-stage verify-before-trust; the model-level license gate now
  fires once and only when a file actually needs the network. **In-app `downloads.ts` still drives `tasks[0]` (the GGUF) only** — the
  projector is the DIY-scripts' job (the canonical two-file path); documented as a residual since no vision manifest ships yet.
- **DIST-2 (HIGH, latent) — the verify/generate side iterates both files.** `models.ts` `manifestFiles` is now EXPORTED (GGUF + mmproj,
  each `{path, sha, localPath}`); `drive.ts` `verifyDriveModels` folds per-file results to one per-model row reporting the FIRST
  non-`verified` file (so a half-installed vision drive — good GGUF, missing/corrupt projector — fails `weightsVerified`), and
  `buildChecksumsJson` emits one entry PER FILE. `assertCommercialDrive` is unchanged (it delegates to `verifyDriveModels`).
  The no-Node DIY mirror `verify-models.{sh,ps1}` was taught the same (block-scoped `mmproj:` parse → a per-file `verify_file`/
  `Write-WeightResult`; `--strict`/`-Strict` now requires BOTH files VERIFIED; `--generate`/`-Generate` emits an entry per file).
- **TEST-1/2/3/4 (test strength).** TEST-1: the security sentinel is now non-vacuous — the answer actually streams through the system
  then the analyze fails, asserting the real `index.ts` catch logs ONLY a content-free `{jobId, error}` (exact key set), plus a
  success-path "answer exists but never reaches a log" check. TEST-2: a NET-NEW injectable idle clock (`IdleClock`/`idleClock` option,
  default real `setTimeout`) makes the RUNTIME-4 races DETERMINISTIC — fire the teardown on demand + gate a child's exit to hold the
  soft-teardown window open; the (b) mid-teardown cold-start, (c) `stop()`-awaits-`idleTeardownPromise`, (e) `unref`, and (a) stale-fire
  inFlight-guard branches now redden if the guard is removed. TEST-3: a vision analyze invokes no OCR engine (`createSelectedOcrEngine`
  spy) and writes nothing under the drive root. TEST-4: a new jsdom `decode.test.ts` covers the client `unsupportedType` (null MIME) +
  over-dimension `tooLarge` rejects.
- **SEC-1 / UX-NIT-1 / DOC-1 / DOC-2 (LOW/NIT).** SEC-1: the `readBytes` stat-failure log now carries `{ext, code}` (errno), never the
  path-bearing `String(err)`. UX-NIT-1: the dead `images.answer.clear` key dropped from `en.ts` + `de.ts`. DOC-1: `user-guide.md` +
  `troubleshooting.md` corrected — a second question is busy-REJECTED (declined, not queued). DOC-2: a `plan §5.1–§5.6` row added to the
  `architecture.md` §9 anchor legend.
**Data contracts (new):** a vision model's `planModelDownloads` now returns TWO tasks (GGUF first, then mmproj); `manifestFiles` is the
shared exported GGUF+mmproj file set used by install AND verify; `buildChecksumsJson` emits one entry per file; the `fetch-models` +
`verify-models` scripts (both `.sh`/`.ps1`) all handle both files. **Residual risk:** the in-app `DownloadManager` (UI) remains
single-file for vision (GGUF via `tasks[0]`) — the `fetch-models` scripts are the two-file download path until a vision drive ships; this
is the ONLY remaining single-file spot, and it's latent (no `role:vision` manifest committed). **Verification:** `npm test`
**1984 passed / 30 skipped (162 files)**; `npm run typecheck` clean; all four scripts smoke-verified on a synthetic vision manifest
(`fetch-models` plans both files; `verify-models --strict` fails a missing projector, passes when both present, `--generate` emits two
entries). **Next:** branch `image-understanding` ready to merge. **(prior entries below.)**_

_2026-06-20 — **Image-understanding Phase V5 (evaluation, hardening, docs — the FINAL phase) SHIPPED — the feature is COMPLETE; branch ready to merge. There is no V6.**
Branch `image-understanding`, implementing the (now-folded) image-understanding plan §16 Phase V5. **The closeout: the env-gated
manual smoke harness + a tiny synthetic fixture, the idle-timeout tuned from the V1 numbers, the §17 matrix re-verified, and the
plan folded into `architecture.md` + deleted — all V1–V4 decisions consumed, not re-litigated; no production code behaviour change
beyond the tuned constant.** **As built:**
- **`tests/manual/vision-smoke.test.ts` — the `HILBERTRAUM_VISION_SMOKE` manual harness (NET-NEW).** Env-gated exactly like
  `gpu-smoke`/`rerank-smoke` (`describe.skipIf(!enabled)`): **SKIPPED — and green — when the env var is unset**, so CI/the green-gate
  never spawns a real binary. When pointed at a drive root (the PAID smoke drive) it finds the off-repo `models/vision/` GGUF + mmproj,
  builds a REAL `VisionRuntime`, and drives it end-to-end: cold start (`--mmproj` loads multimodal) → analyze the committed fixture →
  STREAM the answer (real SSE → `readChatSSE`) → warm follow-up (the `cache_prompt` reuse) → RUNTIME-4 idle teardown (small test idle
  window) → cold restart. Logs the headline numbers (cold-start+TTFA, decode tok/s); peak RSS co-resident stays the
  `scripts/measure-peak-rss.ps1` job. **No multi-GB weights / user images committed.**
- **`tests/fixtures/vision/chart.png` (1734 bytes) + `make-fixtures.mjs` — the ONLY new repo image bytes.** A SYNTHETIC, content-free
  320×240 bar chart drawn procedurally by the committed generator (license-clean by construction — we author it; no PII, no real
  document). `.gitattributes` already treats `tests/fixtures/**` + `*.png` as binary.
- **Idle-timeout TUNED: `DEFAULT_VISION_IDLE_MS` 180 000 → 120 000 ms (2 min — the LOWER end of the §19.13 2–5 min band).** Rationale
  (now in the constant's doc comment + `model-benchmarks.md` §8.3): the follow-up prefill is already `cache_prompt`-cached, so a warm
  sidecar only saves the seconds-scale model *load* — while the idle ~4.6 GB sits co-resident with a 12B chat (PROD-1 pushes a real
  machine >16 GB), so reclaiming it sooner is the higher-value trade. `runtime.ts` constant + the `idleTimeoutMs` option doc updated;
  no test asserted the old default (every test passes `idleTimeoutMs` explicitly), so the change is behaviour-safe.
- **§17 matrix re-verified, NOT duplicated.** Status/limits/manifest/IPC/preload/renderer/SSE-fixture/security-sentinel are all covered
  V2–V4 (the V4 `vision-security.test.ts` loopback + no-content-in-log/audit sentinel satisfies §17's security row on success + failure
  paths); the ONLY genuinely missing §17 item was the env-gated runtime smoke — now added. No new CI test was needed or written.
- **Docs — the doc-lifecycle execution.** The plan was **condensed into `architecture.md` "Image understanding — design record"
  §1–§9** (decisions table · hard rules · the V1-resolved b9585 facts · alternatives · design-as-built module map+flow · the RUNTIME-4
  idle interlock · security/privacy · limits+RAM+the commercial-gate deferral · **a §9 §-anchor legend** keeping the in-code `§N`/
  `RUNTIME-*`/`SEC-*`/`PROD-*`/`IPC-*`/`DIST-*` citations resolvable, the Skills-record precedent) and **`docs/image-understanding-plan.md`
  DELETED** (`git rm`; full original in history). Overview screen list + Swappable-interfaces (`VisionAnalyzer`) + the module map gained
  vision. **`model-policy.md`:** the `vision` role + `mmproj` projector schema + RAM tiering + the **Qwen2.5-VL-3B-Instruct
  `license_review` = approved (Apache-2.0)** against the upstream base `Qwen/Qwen2.5-VL-3B-Instruct` (ggml-org GGUF, mechanical-conversion
  provenance posture). **`drive-layout.md`** (`models/vision/` + `model-manifests/vision/` in both layout sketches), **`packaging.md`**
  (the two-`DownloadJob`-sharing-one-`modelId` topology + the `vision-smoke` harness-matrix row + a pre-ship checklist item), **`known-limitations.md`**
  (CPU prefill latency + the 1536 downscale lever, RAM co-residency PROD-1 >16 GB, single-image/no-persistence, OCR-vs-vision separation,
  ctx-4096, the mmproj-not-yet-in-the-sell-gate note), **`user-guide.md`** (new **§8 "Ask about an image"**, subsequent sections renumbered
  9–13, the nav + cross-ref fixed), **`troubleshooting.md`** (two Images entries), **`model-benchmarks.md` §8** (the V1-measured numbers +
  the harness protocol). **Commercial-drive gate: DEFERRED, not half-wired** — no `role: vision` manifest ships on a sold drive, so
  `assertCommercialDrive` is unchanged; the decision + the future extension (verify the projector alongside the GGUF) is recorded in the
  design record §8 + known-limitations.
**§0 honored:** no cloud/telemetry; the harness is env-gated + skipped in CI (no real binary spawned in a CI-run test); only a tiny
synthetic license-clean fixture committed (never weights/user data); loopback-only + no-content-in-log/audit unchanged (the V4 sentinel
still passes). **Data contracts:** none changed. **Verification:** `npm test` (apps/desktop) **1965 passed / 30 skipped (177 files)** —
full-suite-guard active (the new manual file is collected + skipped), **green-gate holds with zero vision models** (`available:false`,
app launches); `npm run typecheck` + `npm run build` clean. **Next:** the image-understanding feature is **CLOSED OUT** — branch
`image-understanding` ready to merge to `master`. **(prior entries below.)**_

_2026-06-20 — **Image-understanding Phase V4 (real local vision runtime — hardening + wiring) SHIPPED — V5 (eval/benchmark/docs) is next.**
Branch `image-understanding`, implementing [`docs/image-understanding-plan.md`](docs/image-understanding-plan.md) §16
Phase V4. **A hardened, tested local vision sidecar with the net-new idle-teardown interlock + lock/quit/cancel teardown
wired, the green-gate intact (zero vision models ⇒ `available:false` and the suite stays green).** All V1-resolved
decisions are consumed, not re-litigated; no renderer change. **As built:**
- **`services/vision/runtime.ts` — the heart of V4 (RUNTIME-4 idle-teardown interlock, NET-NEW; `e5.ts` has no idle
  timer).** Real `ensureStarted` single-flight (concurrent callers share one start promise) keeps the V2 `startFailed`
  latch + `stopped` guard; `analyze` is unchanged on the wire (base64 `image_url` data-URL, `cache_prompt:true`,
  `readChatSSE` reused — V1-confirmed) but now wrapped by `runAnalyze` so the public `analyze` can drive the interlock.
  **Interlock:** an `inFlight` counter + an `idleTimer` (default **~3 min**, env `HILBERTRAUM_VISION_IDLE_MS`, §19.13
  tune-later) + an `idleTeardownPromise`. The timer is **cancelled on every `ensureStarted()`/`analyze()` entry** and
  **rearmed only when the LAST in-flight analyze settles** (`inFlight===0`). The idle teardown is a **SOFT** teardown
  (kills the child, nulls `this.server`, but does **NOT** latch `stopped`) so the next analyze cold-starts cleanly; it is
  **guarded** against `stopped`/`starting`/`inFlight>0` so it can never fire under a running job, and an analyze arriving
  mid-teardown sees `server===null` and cold-starts a **fresh, independent** child (the old one finishes stopping on its
  own). `stop()` (permanent — lock/quit/cancel) now also **cancels the idle timer + awaits an in-flight soft teardown**
  so no child orphans on quit; the idle timer is `unref()`-ed so it never blocks a clean exit. The §12 temp-file fallback
  was **not** built (V1 = base64 no-disk).
- **`services/vision/index.ts`** — `VisionService.stop()` now **aborts any in-flight job FIRST** (so it ends `cancelled`,
  not a scary `runtimeFailed`) then tears the runtime down via a typed optional `VisionAnalyzer.stop?()`; the orchestrator
  discards the runtime, so the next analyze rebuilds a fresh one (no `suspend()`/latch distinction needed — RUNTIME-3
  one-job latch + IPC-3 busy-reject from V2 are unchanged and re-verified under the real path).
- **Lifecycle wiring** — `context.ts` gains `ctx.vision?: VisionService`; `main/index.ts` **builds it once** (so the
  teardown paths can reach it) + adds `ctx?.vision?.stop()` to the `will-quit` `Promise.allSettled`; `registerWorkspaceIpc`
  **stops it on workspace LOCK** beside `ctx.embedder.suspend()` (its llama-server KV cache holds the decoded image + prompt,
  so it must die before the vault re-encrypts). `getVisionStatus` stays **workspace-agnostic** (PROD-2 — no `'locked'`
  reason); the screen owns the lock gate, the sidecar teardown is independent.
- **Caps** — the renderer dimension cap (V3 `decode.ts`, 4096 hard / 1536 downscale) + the main-side byte/extension cap
  (`limits.ts`, SEC-3) are both already on the real path; not duplicated.
**§0 honored:** loopback-only (sentinel asserts every fetch host is 127.0.0.1), **no image/prompt/answer content in
logs/audit** (sentinel asserts absence + that vision writes ZERO audit rows), no native dep, CSP untouched.
**Data contracts:** none changed (`ctx.vision` is an internal main-process handle; `images:*` IPC + `STREAM.img*` +
`VisionStatus`/`ImageJob` as-is). **Verification:** `npm test` (apps/desktop) **1965 passed / 29 skipped (176 files)** —
full-suite-guard active, green-gate holds; `npm run typecheck` + `npm run build` clean. New tests:
`tests/integration/vision-runtime.test.ts` (9 — single-flight, startFailed latch, cancel-aborts-fetch, no-orphan-on-stop,
idle teardown + cold restart, no-teardown-while-running, timer-reset, stop-cancels-timer), `tests/unit/vision-sse.test.ts`
(2 — SSE regression on the V1 fixture + partial-UTF-8-across-frames), `tests/integration/vision-security.test.ts` (2 —
loopback-only + no-content-in-log/audit sentinel, success + failure paths), + a lock-teardown case in `workspace-ipc.test.ts`
and a `service.stop()` abort case in `images-ipc.test.ts`. **Risks/notes:** the idle-timeout default (180 000 ms) is a
placeholder in the §19.13 2–5 min band — tune in V5 with real numbers; the RUNTIME-4 races are covered by deterministic
small-timeout tests (the documented vitest load-flakiness can surface a transient unrelated failure under heavy parallel
load — a re-run is green). **Next:** V5 — benchmark fixtures + the `HILBERTRAUM_VISION_SMOKE` manual harness, model-policy/
known-limitations docs, fold the plan into `architecture.md` + delete the plan file, commercial-drive gates. **(prior entries below.)**_

_2026-06-20 — **Image-understanding Phase V3 (Images screen UI) SHIPPED — V4 (real runtime hardening) is next.**
Branch `image-understanding`, implementing [`docs/image-understanding-plan.md`](docs/image-understanding-plan.md)
§16 Phase V3. **A wired, tested Images screen that drives the V2 backend and shows the calm unavailable state
with zero vision models present — renderer UI only, no V4 runtime work.** All V1/V2 locked decisions are encoded.
**As built:**
- **Nav / routing / glyph / IA** — `'images'` added to `ScreenId` + `resolveNavTarget` (`renderer/navigation.ts`);
  `{ id:'images', labelKey:'nav.images', icon:'image' }` added to `NAV_TOP` **after Documents, before AI Model**
  + the render branch `{screen==='images' && <ImagesScreen onNavigate={navigate}/>}` (`renderer/App.tsx`); a new
  `'image'` glyph (Feather frame+sun+mountain) in `IconName`/`GLYPHS` (`renderer/components/Icon.tsx`). **IA
  honesty:** this is a genuine **6th primary destination** — `docs/design-guidelines.md` §2 updated to "6 primary +
  1 utility" (was 5); `InformationArchitecture.test.tsx` (7 real destinations, nav list now Home·Chat·Documents·
  **Images**·AI Model·Skills‖Settings) + `rail-labels.test.ts` (nav.images, Images/Bilder fit) updated.
- **i18n** — `nav.images` (EN "Images" / DE „Bilder") + the full `images.*` block (title/body, reason-adaptive
  `avail.*`, `locked`, `drop.*`, `preview.*`, the six `chip.*` label+prompt pairs, `composer.*`, `answer.*`,
  `err.*`) added to **both** `shared/i18n/en.ts` and `de.ts` (German informal „du", glossary-consistent; parity
  green — typecheck enforces it).
- **`renderer/screens/ImagesScreen.tsx`** — owns the §5.6 state machine (unavailable/empty/selected/
  starting/analyzing/answered + every error row) and the **ephemeral** per-image thread; fetches
  `imageGetStatus()` on mount + **re-checks on window `focus`** (a model may have been installed via AI Model);
  defensive `getAppStatus().workspaceReady` lock posture (the app shell already gates lock globally). Streaming
  mirrors Chat: `imageAnalyze` → subscribe `onImageToken`/`onImageDone`/`onImageError`, busy-reject (no enqueue),
  Stop=`imageCancel`, new-image-mid-analysis cancels + resets the thread, unmount tears down. Friendly codes only
  (no raw model/runtime text); `data:`-preview only (CSP untouched).
- **`renderer/images/`** (mirrors `renderer/chat/`) — `ImageDropZone` (drag-drop + "choose an image", multi-drop
  reject, keyboard-activatable), `ImagePreview` (`data:` URL, filename/dims/size, Remove/Replace), `QuestionComposer`
  (auto-grow textarea, Enter=send/Shift+Enter=newline, suggestion Chips fill-don't-auto-send), `AnswerThread`
  (ephemeral turns, ambient "Generated locally…" note, streaming caret + Stop, friendly error/stopped rows),
  `VisionUnavailable` (§5.1 reason-adaptive `EmptyState`, CTA→`onNavigate('models')`, OCR pointer), `decode.ts`
  (the §11 algorithm — `createImageBitmap({imageOrientation:'from-image'})` → downscale longest side to 1536 →
  re-encode to input MIME (JPEG q0.9) on `OffscreenCanvas`/`<canvas>` → `data:` URL; EXIF stripped by the canvas
  draw; best-effort fallback to original bytes; **no native dep**; injectable as the `decodeImpl` test seam), +
  `index.ts` barrel. CSS for the drop zone + two-pane workspace added to `renderer/styles.css`.
**§0 honored:** no cloud/telemetry, **no new native npm dep** (browser APIs only), sandbox/CSP untouched
(`img-src 'self' data:`), no image/prompt/answer content in logs. **Data contracts:** none changed (consumes the
V2 `images:*` IPC + `STREAM.img*` + `VisionStatus`/`ImageAnalyzeRequest`/`ImageJob` as-is). **Verification:**
`npm test` (apps/desktop) **1950 passed / 29 skipped (173 files)** — full-suite-guard active; **green-gate holds
with zero vision models** (the screen shows the calm `VisionUnavailable` card and the app launches); `npm run
typecheck` + `npm run build` clean. New test: `tests/renderer/ImagesScreen.test.tsx` (12 — unavailable/empty/
selected/streaming/error/empty-response/chip-fills-composer/Remove-resets/new-image-cancels/Stop), plus the
IA + rail-labels updates. **Next:** V4 — real `VisionRuntime` `ensureStarted`/`analyze` (V1-resolved args),
idle-teardown interlock, lock-teardown wiring, renderer dimension cap. **(prior entries below.)**_

_2026-06-20 — **Image-understanding Phase V2 (backend skeleton) SHIPPED — V3 (renderer UI) is next.**
Branch `image-understanding`, implementing the (V1-cleared) [`docs/image-understanding-plan.md`](docs/image-understanding-plan.md)
§16 Phase V2. **A wired, tested backend skeleton that reports `available:false` with no vision model present — no
renderer UI yet.** All V1 locked decisions are encoded, not re-litigated. **As built:**
- **`shared/manifest.ts`** — `vision` added to the role set; a new optional **`mmproj` projector sub-block**
  (`MmprojSpec`: `local_path`/`sha256`/optional `download`), validated when present and **required iff
  `role: vision`**; the top-level `download` + `mmproj.download` validation is now one shared
  `validateDownloadSubBlock` (https-only L-2; a real `mmproj.download.sha256` must equal a real
  `mmproj.sha256`); optional informational `input_modalities`. Unknown keys still ignored (forward-compatible).
- **`services/models.ts`** — vision install state = **both files present + verified**. New `mmprojPath` +
  `manifestFiles` (GGUF + projector) thread through `computeInstallState` (precedence unchanged: unsupported →
  missing(either) → checksum_failed(either) → installed), the lazy `skipHash`/RT-3 path, and `pendingHashBytes`;
  the two-tier checksum cache keys each file by `(path,size,mtime)`, so the projector is hashed once like the GGUF.
- **`services/drive.ts`** + both `prepare-drive.{ps1,sh}` — `models/vision/` + `model-manifests/vision/` added to
  `DRIVE_LAYOUT_DIRS` / the script dir lists (manifests still discovered recursively — no discovery change).
- **`shared/types.ts`** — `VisionStatus` (`VisionUnavailableReason = no-model|no-runtime|incompatible`, **NO
  `'locked'` — workspace-agnostic, PROD-2**), `ImageAnalyzeRequest`, `ImageJobState`, `ImageJob`, `VisionErrorCode`
  (`tooLarge|unsupportedType|decodeFailed|runtimeFailed|emptyResponse|cancelled|busy`). `ModelInfo.role` gains `vision`.
- **`shared/ipc.ts` + `preload/index.ts`** — `images:getStatus|chooseImage|readBytes|analyze|cancel|getJob`
  channels, `STREAM.imgToken/imgDone/imgError(jobId)`, and the typed `window.api` methods + the three `onImage*`
  subscribers (`PreloadApi` extends automatically).
- **`services/vision/`** — `status.ts` (`getVisionStatus`: no-runtime → no-model → incompatible → available;
  cheap, lazy, **lock-safe**), `limits.ts` (`VISION_MAX_IMAGE_BYTES` ~20 MiB env-overridable + extension/MIME
  guards + `validateAnalyzeRequest`), `runtime.ts` (`VisionRuntime` composing `LlamaServer` DIRECTLY — does NOT
  inherit `CHAT_SERVER_ARGS`; V1 args `extraArgs:['--mmproj',proj,'--device','none']`, NO `--reasoning-format`,
  base64 `image_url` data-URL request with `cache_prompt:true`, `readChatSSE` reused; the idle-timer/lock teardown
  are V4), `index.ts` (`VisionService`: ephemeral job map, vision's **OWN** one-job serialization — RUNTIME-3 —
  busy-**REJECT** not queue (IPC-3), cancel via AbortController, unknown jobId ⇒ terminal failed).
- **`ipc/registerImagesIpc.ts`** (registered in `main/index.ts`) — `getStatus` (no unlock), file/runtime handlers
  `requireUnlocked`; `chooseImage` returns **`{path,name,sizeBytes}`** (IPC-2, new shape); `readBytes`/`analyze`
  **re-validate extension + byte cap in MAIN** (SEC-3, net-new). Two i18n dialog keys added (en+de parity).
**§0 honored:** no cloud/telemetry, no native npm dep, sandbox/CSP untouched, loopback-only, no image/prompt/answer
content in logs/audit. **Data contracts (new):** `images:*` IPC + `ImageJob`/`VisionStatus`/`ImageAnalyzeRequest`
+ `STREAM.img*`; manifest gains `mmproj`/`input_modalities`. **Verification:** `npm test` (apps/desktop) **1937
passed / 29 skipped (172 files)** — full-suite-guard active; **green-gate holds with zero vision models**;
`npm run typecheck` + `npm run build` clean. New tests: `vision-status.test.ts`, `images-ipc.test.ts`,
`preload-vision.test.ts`, + vision/mmproj cases in `manifest.test.ts`/`models.test.ts`/`drive.test.ts`.
**Next:** V3 — the Images nav item + `ImagesScreen` (states §5.6), drop zone/picker, client decode/downscale,
wired to the V2 backend (friendly unavailable when no model). **(prior entries below.)**_

_2026-06-20 — **Image-understanding Phase V1 (research gate) PASSED on the real pinned b9585 — V2–V5 UNBLOCKED.**
Branch `image-understanding`. Ran the V1 gate against the real binary on the PAID smoke drive
(`F:\paid-gpu-smoke-drive`, runtime `b9585 (d73cd0767)`, vulkan build + `cpu/` net). **No app feature code yet
— research only.** All multi-GB weights live OFF-repo on the smoke drive (`models/vision/`, never committed); the
**only repo change is `apps/desktop/tests/fixtures/vision/vision-sse-sample.txt`** (a verbatim real SSE capture for
the CI parser regression). **GATE OUTCOME — §7 gate #1, branch #1 (the best case): Option A confirmed, NO runtime-pin
bump needed.** `llama-server --mmproj` on b9585 **loads multimodal cleanly** and **answers `/v1/chat/completions`
with a base64 `image_url` data-URL — no disk write** (the temp-file fallback / Option C / pin-bump branches are all
avoided). **Multimodal CLIs are also bundled** (`llama-mtmd-cli.exe`, `llama-llava-cli.exe`, `llama-gemma3-cli.exe`,
`llama-minicpmv-cli.exe`) — Option C remains available as a fallback, unused.

**Resolved runtime args (RUNTIME-2 — the vision sidecar composes `LlamaServer` DIRECTLY, does NOT inherit
`CHAT_SERVER_ARGS`):** flag spelling **`--mmproj <file>`** (alias `-mm`, env `LLAMA_ARG_MMPROJ`); **`--jinja` is
default-ENABLED on b9585** (`--help`: "--jinja, --no-jinja … (default: enabled)") so vision gets the jinja chat-template
path without inheriting it — passing it explicitly is optional/harmless; **`--reasoning-format` MUST be left at default
(do NOT pass `deepseek`)** — Qwen2.5-VL is non-reasoning, emits no `reasoning_content` frames; CPU-pin via **`--device
none`** works (mirrors `e5.ts` embedder). Request shape: OpenAI `content:[{type:'text'},{type:'image_url',image_url:{url:'data:<mime>;base64,…'}}]`.
**`cache_prompt:true` → the image prefill is CACHED across follow-ups** (measured `cache_n:2812, prompt_n:1` on the 2nd
question of the same image) — the per-image thread (§2 follow-ups) pays the image prefill ONCE, not per question; set it
like `llama.ts:239`. **SSE reuse CONFIRMED → streaming-by-default (§19.10) STANDS:** the streamed frames are byte-identical
to text chat (`data: {…chat.completion.chunk…}` with `choices[0].delta.content`, role-first `content:null` frame, terminal
`finish_reason` + `data: [DONE]`) — **`readChatSSE` (`runtime/llama.ts`) parses them unchanged**, no vision-specific reader
needed; the contingency poll-fallback is NOT triggered. Fixture captures the partial-UTF-8-across-frames case too.

**CHOSEN PRODUCTION CANDIDATE — Qwen2.5-VL-3B-Instruct (ggml-org GGUF, Apache-2.0, the §19.4 default):** loads + answers
on b9585.
  - GGUF `Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf` — size `1929901056` (1.93 GB) — sha256 `d02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12`
  - mmproj `mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf` — size `1338428128` (1.34 GB) — sha256 `b9160fe9d814d1fadf68395677468534778b39ac33c2e7561b7b218626e60d5e`
  - combined `size_on_disk_gb` ≈ **3.27 GB**; **measured peak RSS ≈ 4.6 GB** (sidecar alone, CPU-pinned, ctx 4096; `PeakWorkingSet64` 4597 MB / private 5126 MB).
  - **Capability check passed:** on the real `german-scan.png` it answered *"This is an invoice from Müller & Söhne GmbH, and it is in German."* — correct doc-type AND read the German text (the 256M reference garbled it).
  - From `https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF` (official llama.cpp org). Repo license `apache-2.0` (HF API). `license_review` to be filled in V5 against the upstream base `Qwen/Qwen2.5-VL-3B-Instruct`.
**Reference (fast mechanics-proof) artifact — SmolVLM-256M-Instruct (ggml-org, Apache-2.0):** also loads/answers; RSS ~402 MB.
  GGUF `SmolVLM-256M-Instruct-Q8_0.gguf` sha256 `2a31195d3769c0b0fd0a4906201666108834848db768af11de1d2cef7cd35e65` (175054528);
  mmproj `mmproj-SmolVLM-256M-Instruct-Q8_0.gguf` sha256 `7e943f7c53f0382a6fc41b6ee0c2def63ba4fded9ab8ed039cc9e2ab905e0edd` (103769856).

**KNOWN LIMITS / RISKS (record in `known-limitations.md` + `model-benchmarks.md` at V5):** (1) **CPU prefill of a full-res
image is SLOW** — the high-res scan was **2813 image tokens → ~52 s prefill** on CPU off USB (~18.5 ms/tok prefill,
decode ~12 tok/s). This makes the §11 **client downscale-to-1536px a real latency lever, not just a payload optimization**
(fewer image tokens ⇒ proportionally less prefill), and keeps **GPU as the §19.11 optimization lever** if CPU TTFA fails the
bar. The `cache_prompt` reuse blunts it for follow-ups but the FIRST question per image pays it. (2) **PROD-1 co-residency
confirmed:** vision peak ~4.6 GB + a 12B chat (~7 GB) + E5 embedder ⇒ **>16 GB**; the manifest `recommended_min_ram_gb`/RAM
gate must keep vision off small tiers. (3) ctx capped at 4096 vs train 128000 (fine for MVP). **Data contracts:** none changed
(no code). **Verification:** docs + one fixture file only; `npm test` (apps/desktop) re-run to honor the per-phase ritual.
**Next:** V2 backend skeleton — `vision` role + `mmproj` validation in `shared/manifest.ts`, `services/vision/status.ts`
(both-files-verified), the `images:*` IPC + `STREAM.imgToken/imgDone/imgError` contract, types — all per the (now
gate-cleared) plan. **(prior entries below.)**_

_2026-06-20 — **Image-understanding plan REVISED to clear its multi-persona audit.** Branch
`image-understanding` (planning only — **no feature code**). Reworked
[`docs/image-understanding-plan.md`](docs/image-understanding-plan.md) to fix **every finding** of the
multi-persona audit `docs/image-understanding-audit-2026-06-20.md`, then **deleted that audit** (fully
remediated; recoverable in git history at the remediation commit, per the CLAUDE.md doc-lifecycle rule).
The plan now carries each decision's rationale inline; its `(SEC-1)`/`(RUNTIME-2)`-style tags are
traceability labels back to the (git-preserved) audit. **Blockers fixed:** SEC-1 — deleted the false "`blob:` already permitted" CSP
claim; preview is **`data:`-only** (prod CSP `img-src 'self' data:`, `main/index.ts:367-369`, lists no
`blob:`), §11/§13 made consistent. RUNTIME-1/2 — Option A downgraded to **candidate pending V1**, V2–V5
**blocked on V1**; the vision sidecar composes `LlamaServer` directly so does **NOT** inherit
`CHAT_SERVER_ARGS` (`--jinja`/`--reasoning-format`) — V1 now must resolve the exact arg set + the
"`--mmproj` works but template path differs" branch. DIST-1 — two-file download reframed honestly
(weightPath/computeInstallState/DownloadJob/downloads.ts/assets.ts/fetch-models.sh are all
single-file); topology **decided = two `DownloadJob`s sharing one `modelId`**. **HIGH/MED:** vision is a
**separate** sidecar needing its **own** one-job serialization (chat+embedder+vision = 3 co-resident,
RUNTIME-3); net-new idle-teardown interlock spelled out (RUNTIME-4); `readBytes` dropped on the
drag-drop path (IPC-1); **busy-reject** chosen over queue (IPC-3); honest 6th-nav-destination framing
(UX-1); `decodeFailed` error code + multi-drop/EXIF/downscale algorithm (UX-3); 12–16 GB bar qualified
against a 14 GB-tier chat model (PROD-1); "locate a license-clean GGUF+mmproj that loads on b9585" made
the literal first V1 task (TEST-1); plus the LOW tightenings (IPC-2/SEC-3/PROD-2/UX-2) and a §19 that
now reads every load-bearing choice as a real decision with a default + cost. **Data contracts:** none
changed (plan only). **Verification:** docs-only edit, no code touched ⇒ `npm test` not required.
**Next:** the plan is build-ready behind its V1 research gate. **(prior entries below.)**_

_2026-06-19 — **Performance Wave P6 landed — the Low opportunistic backlog closed; audit report RETIRED.**
Branch `performance-low-backlog` (off `master`). The closing pass over the perf audit's **Low** §4 findings,
all behavior-preserving internal optimizations. **Shipped (✅):** DB-8 (targeted document getters
`getDocumentOrigin`/`getDocumentSummary`/`getDocumentOcrPages` project one TEXT column each, not `SELECT *`),
RAG-5 (per-embedder query-vector LRU in `embeddings/index.ts` — keyed by exact query, `WeakMap` by embedder
instance ⇒ fresh on model swap; +4 tests), RAG-7 (retrieval budget reads persisted `chunks.token_count`;
`messageTokens` memoized by message identity), ING-6 (comment — `materializeDocument`'s disk round-trip is a
deliberate canonical-import-path reuse), ING-7 (re-index status read/write coalesced: 4 statements → 2),
ING-8 (OCR `readStoredPdfBytes` → async `readFile`, method now `async`), ING-9 (`coalesceSegments` joins
once), ING-10 (`wordTokenCount` per-word fast path in `chunker.ts`), FE-8 (`useMemo` `previewDoc` + `titleOf`
via the `sourcesById` Map — kills six `docs.find` per preview), FE-10 (runnable-tools effect keys on
`[skill, conversation]`, drops `messages.length`), RAG-8 (comment only — `alignNodes` O(n²) is over tens of
sections). **Accepted residuals (deferred, reasons in architecture.md Wave P6):** DB-8 `listDocuments`
`ocr_json` (badge metadata lives only in that column; removing it needs a schema migration or non-byte-
identical SQL-JSON), FE-9 (post-DB-3 `listDocuments` is cheap; a shared cache risks staleness / a bootstrap
IPC is a non-trivial new surface), RT-6/7/8 (measure-first / already-mitigated-by-ordering / bounded one-event),
RT-9 (§17(b) is a latent-only win but a behavior-sensitive fence-sizing change), and the renderer tail
FE-3/FE-4/FE-5 (not confidently safe under the behavior-preserving mandate). **Data contracts:** none changed
(every fix is internal; `RetrievedChunk`/`DocumentPreview`/IPC shapes untouched). **Verification:** `npm test`
**1899 passed / 29 skipped** (+4 RAG-5 tests), typecheck + `npm run build` clean. **Docs:** decisions folded
into [`docs/architecture.md`](docs/architecture.md) "Performance — design record … Wave P6 — Low backlog";
**`docs/performance-audit-2026-06-18.md` DELETED** per the doc-lifecycle rule (High/Medium records already in
the Wave P1–P5 sections; full original in git history). **Open residuals:** only the deferred-with-trigger
items above — P4b worker scan (trigger unmet), P4c ANN/sqlite-vec (rejected, D15), FE-3/4/5 renderer tail.
**Next:** branch ready to merge. **(prior entries below.)**_

_2026-06-19 — **Vitest harness hardened against silent file-drop (follow-up to the merge note below).**
The merge note flagged that vitest's parallel pool can, under heavy machine load, **silently drop a
test file** — a worker fails to collect it and the run reports a *lower* file total (e.g. 168 instead
of 169) with **no error and a green exit**. A dropped suite that "passes" by not running is a false
green. **Fix (two parts):** (1) **`tests/full-suite-guard.ts`** — a vitest `Reporter` whose
`onFinished` walks the test tree on disk (`listTestFiles`) and asserts vitest collected **every**
file; any missing → it **throws**, which is the *only* mechanism that reliably forces a non-zero exit
(verified: a throw from `onFinished` exits 1; setting `process.exitCode` there does **not** stick).
It self-gates: `vitest.config.ts` passes the expected file list **only on an unfiltered full run**
(argv after the `run` subcommand is flags-only; any positional ⇒ subset ⇒ guard handed `null` ⇒
no-op), so `npm test -- tests/unit` / watch mode never false-fail. The expected count is computed
from disk each run, so it auto-tracks as suites are added/removed (no hardcoded 168). (2) **Pool
pinned explicitly** (`pool: 'forks'`) so collection behaviour is deterministic across vitest
upgrades; `forks` is required anyway because parts of the suite touch native bindings (node:sqlite,
llama) that don't share across threads. `testTimeout: 15_000` unchanged. **Verification:** full
`npx vitest run` → **1895 passed / 29 skipped (169 files)**, exit 0, guard active. **Forced-drop proof:**
`vitest run --exclude=tests/unit/chunker.test.ts` (stays "full" via the `=`-form, drops 1 file) → guard
**throws naming the dropped file, exit 1** (was a silent green before). Filtered subset run → guard
no-ops, exit 0 (no false-fail). `npm run typecheck` + `npm run build` clean. New file count is **169**
(added `tests/full-suite-guard.ts` [not a `.test`, not collected] + `tests/unit/full-suite-guard.test.ts`
[+5 tests]). NOT committed (awaiting the user's go); push to origin/master pending after confirmation.
**(prior entries below.)**_

_2026-06-19 — **Context budgeting + conversation compaction — MERGED to `master`.**
`git merge --no-ff context-window-compaction` (merge commit, master was the merge-base so the merge was
conflict-free) brought Phases 0–2 + the close-out onto `master`: the merged 5 commits are `ae22ba6` (plan,
since deleted), `37bc6aa` (Phases 0–1), `4dca3e3` (Phase 2 UX), `964e647` (the onCompaction test-mock
typecheck fix), `279af21` (close-out + rag-design.md §15 record). **Verified on the merged tip:** `npm test`
**1890 passed / 29 skipped (168 files)**, `npm run typecheck` + `npm run build` clean. **Harness note (not a
regression):** vitest intermittently drops ~4 test files (32 tests) from a run under parallel-pool load —
**silently, no error, the total just reads lower** (some feature-branch runs showed 1858/164 instead of the
complete 1890/168). The true file total is 168 (all under `apps/desktop/tests`; 15 are env-gated
`tests/manual` smoke skips). Every observed run was all-green; the swing is collection flakiness, pre-existing
and branch-independent — but worth fixing the harness (e.g. pin the pool / fail on under-collection) so a
future genuinely-dropped suite can't pass unnoticed. **NOT pushed; the `context-window-compaction` branch is
left intact** (not deleted) per the user. **(prior entries below.)**_

_2026-06-19 — **Context budgeting + conversation compaction — FEATURE CLOSED OUT (Phase 3 deferred per D-c).**
Branch `context-window-compaction`. **Decision (with the user): do NOT build Phase 3 now** — the optional
`/tokenize`-backed exact-count-near-threshold upgrade. Rationale: the word estimate is safe-biased (R9 —
over-counting only summarizes *early*, harmless; the L1 `fitMessagesToContext` floor still guarantees fit
if it triggers late), so Phase 3 only earns its keep if the threshold proves *jumpy in real use*, which has
not been observed (the feature isn't in real use yet). It also isn't free — llama-server's `/tokenize` does
NOT apply the chat template, so even the "exact" path would tokenize per-message content + a per-message
overhead fudge, trading a known safe over-count for a new approximation + an HTTP round-trip + a new
optional interface method. `messages.token_count` stays NULL. Revisit only if the boundary proves jumpy.
**Doc-lifecycle close-out done (per CLAUDE.md):** the working-paper plan `docs/context-compaction-plan.md`
is condensed into a §-numbered **design record** [`docs/rag-design.md`](docs/rag-design.md) **§15**
(15.1 L0 window source-of-truth · 15.2 token accounting + trigger · 15.3 L2 pre-pass + checkpoint
persistence · 15.4 summary representation + summarizer call · 15.5 UX meter/notice/marker/toggle ·
15.6 deferred Phase-3 + R7/R10 guardrails), with a stable **anchor map** so the existing code/test comments
that cite the old plan (`§L0`, `§4.x`, `§5.x`, `Rn`, `D-x`) resolve into §15.x. Cross-reference added from
[`docs/architecture.md`](docs/architecture.md) "Chat & streaming" (a new "Conversation compaction (L2)"
bullet → §15). **Plan file DELETED** (`git rm`); full original preserved at
`git show 4dca3e3:docs/context-compaction-plan.md`. **One pre-existing typecheck defect fixed (not from
this step):** committed Phase-2 test `tests/renderer/ChatCompaction.test.tsx` typed its `onCompaction`
mock callback `() => void` while the real preload signature is `(notice: CompactionNotice) => void` —
`npm test` (esbuild, no typecheck) passed so it slipped the Phase-2 "typecheck clean" claim. Fixed to the
real signature (import `CompactionNotice`, call `compactionCb!({ phase: 'start' })`); behaviour unchanged.
**Verification:** `npm test` **1890 passed / 29 skipped**, `npm run typecheck` clean (was failing on the
above before the fix), `npm run build` clean. NOT committed (awaiting the user's go). The feature
(Phases 0–2) is complete and recorded; this branch is ready to commit/merge. **(prior entries below.)**_

_2026-06-19 — **Context budgeting + conversation compaction — Phase 2 (UX) landed.**
Branch `context-window-compaction`. Implementing [`docs/context-compaction-plan.md`](docs/context-compaction-plan.md)
(WORKING PAPER — Phase 3 optional `/tokenize` still open; §6 Phase 2 marked ✅ with the full as-built).
Phase 2 is **additive UX + one settings gate** over the Phase-1 L2 mechanism — the summary pair /
checkpoints are UNCHANGED. **As-built (files):** `shared/ipc.ts` — `STREAM.compaction(requestId)` +
`CompactionNotice {phase:'start'}` (mirrors `STREAM.scope`), new read channels
`getConversationContextUsage` + `getConversationSummary`. `ipc/chat-stream.ts` — `withChatStream`'s
`runFn` gained a 4th arg `sendCompaction` (a `SendCompaction` notifier) beside `sendToken`/
`sendReasoning`: isDestroyed-guarded but **NEVER buffered into `streamBuffers`** (R14, ephemeral); both
IPC handlers wire it as `onCompactionStart` (`registerRagIpc` only on the grounded path). `preload` —
`onCompaction` (mirrors `onScopeNotice`) + `getConversationContextUsage`/`getConversationSummary`.
`services/chat.ts` — `compactionEnabled(db)` (the §5.4 gate), `getConversationContextUsage(db,
runtime|null, convId)` (pure read: assembles via `buildChatMessages` over `effectiveContextWindow`, sums
`messageTokens`; window falls back to `settings.contextTokens` with no runtime), `getConversationSummaryMarker`
(computes `beforeMessageId` = first turn `rowid > coversThroughRowid`, since `Message` has no rowid).
`shared/types.ts` — `ContextUsage`, `ConversationSummaryMarker`, `AppSettings.chatCompactionEnabled`
(default **true**; the defaults-merge IS the migration — no schema change). Renderer: new
`chat/ContextMeter.tsx` (thin composer-footer bar, calm/amber/near-full, approximate tooltip),
`Transcript` gained an expandable `SummaryMarker` + the "summarizing…" notice above the streaming bubble,
`ChatScreen` subscribes `onCompaction` (clears on first answer token + in `finally`) and refreshes the
meter/marker on switch + post-turn, `SettingsScreen` General gained a "Chat" card with the toggle.
en+de i18n keys added (parity green). **Data contracts:** `STREAM.compaction(id)`→`CompactionNotice`;
`getConversationContextUsage(convId)`→`ContextUsage|null`; `getConversationSummary(convId)`→
`ConversationSummaryMarker|null`. **§5.4 gate behaviour (chosen + documented):** `chatCompactionEnabled=false`
⇒ no new checkpoints AND assembly + the marker reader IGNORE any existing checkpoint (full-history replay,
pure L1) = byte-identical to the pre-feature app. **§5.1 deviation (documented):** the usage rides the
resting IPC for BOTH the resting state and the post-turn refresh (the renderer awaits the invoke + re-reads
history, never consumes `onDone`, and `done` is the locked Message contract) — the locked streaming
contract is left untouched. **Invariants held:** no new network surface; the compaction notice is
ephemeral (R14); all user-visible strings via `shared/i18n` (en+de), internal prompts English.
**Verification:** `npm test` **1890 passed / 29 skipped** (+12: new
`tests/integration/chat-compaction-ux.test.ts`, `tests/integration/chat-compaction-ipc.test.ts`,
`tests/renderer/ChatCompaction.test.tsx`); typecheck + `npm run build` clean. NOT committed (awaiting the
user's go). **Next: Phase 3 (optional)** — `/tokenize`-backed exact counts near the threshold. **(prior
entries below.)**_

_2026-06-19 — **Context budgeting + conversation compaction — Phase 1 (compaction core) landed.**
Branch `context-window-compaction`. Implementing [`docs/context-compaction-plan.md`](docs/context-compaction-plan.md)
(WORKING PAPER — Phases 2–3 still open; §6 Phase 1 marked ✅ with the full as-built). **L2 — summary
compaction** now sits as an `await ensureCompacted(...)` pre-pass inside BOTH chokepoints
(`generateAssistantMessage`, `generateGroundedAnswer`), right after the window is resolved (§L0
`effectiveContextWindow`) and BEFORE assembly. When the assembled history reaches `COMPACT_THRESHOLD`
(0.85) × window and ≥ `MIN_COMPACTABLE_TURNS` (6) turns sit older than the protected `KEEP_RECENT_TURNS`
(6) tail, it summarizes the older region ONCE into a cached **checkpoint** and assembly thereafter replays
a synthetic summary pair + only the post-checkpoint turns. **Fail-safe by construction:** below threshold
⇒ no model call; any summarizer failure/abort ⇒ NO checkpoint, the turn proceeds via the unchanged L1
`fitMessagesToContext` floor with no user-visible error; with no checkpoint, behaviour is byte-identical
to before. **As-built (files):** NEW
[`services/chat/compaction.ts`](apps/desktop/src/main/services/chat/compaction.ts) (`ensureCompacted`,
constants, `selfSummaryPrompt` VERBATIM §4.8, the non-thinking `mode:'balanced'`+temp 0.2+maxTokens 700
summarizer, chained re-compaction via `doctasks/summary.ts` windowing).
[`db.ts`](apps/desktop/src/main/services/db.ts): additive `ensureColumn(messages,'kind')` +
`covers_through_rowid` (R13, NULL-sentinel = plain message) and the R8 FTS fix — `messages_fts_ai` gains
`WHEN new.kind IS NOT 'compaction'` (fresh DBs) + idempotent `ensureMessagesFtsKindFilter` rewrite/prune for
pre-feature DBs, backfill SELECT also kind-filtered. [`chat.ts`](apps/desktop/src/main/services/chat.ts):
checkpoint writer/reader + `listConversationTurns` (rowid-aware, kind-filtered) **kept here** (the existing
message-SQL owner, not `db.ts` — least-disruptive deviation), `compactionSummaryPair` (§4.5
`user→assistant`, NEVER persisted, never skill-stamped — R3), `kind`-filter on `listMessages` (renderer/
export/fence auto-skip checkpoints — R8), `messageTokens` exported; `buildChatMessages` injects the pair +
post-checkpoint replay; `onCompactionStart` plumbed. [`rag/index.ts`](apps/desktop/src/main/services/rag/index.ts):
same for `buildGroundedChatMessages`/`generateGroundedAnswer` — checkpoint built from STORED RAW turns, the
live final grounded turn (question + `[Sn]`) untouched + mandatory (R-RAG). **Data contracts:**
`messages.kind TEXT` (NULL|'message'|'compaction') + `messages.covers_through_rowid INTEGER` (max subsumed
rowid); a `kind='compaction'` row (role `system`, `skill_id` NULL) holds the summary; `Checkpoint
{ rowid, summary, coversThroughRowid }`; `ConversationTurn { rowid, role, content }`. **Summarize-once**
guaranteed: the trigger estimates the ASSEMBLED view (existing summary-pair + post-checkpoint turns), so a
fresh checkpoint drops the next turn below threshold; re-compaction only fires after NEW turns re-cross it,
folding the prior summary. **Settled product decisions unchanged:** D-a default ON (Phase-2 toggle not yet
read ⇒ effectively always-on now), D-b expandable transcript (Phase 2). **Verification:** `npm test`
**1878 passed / 29 skipped** (+15, new `tests/integration/chat-compaction.test.ts`); typecheck + `npm run
build` clean. NOT committed (awaiting the user's go). **Next: Phase 2** — UX: `STREAM.compaction` channel +
`onCompaction` preload + the "summarizing…" status line, the composer context-usage meter, the
`chatCompactionEnabled` settings toggle, the expandable transcript summary marker, en+de i18n. **(prior
entries below.)**_

_2026-06-19 — **Context budgeting + conversation compaction — Phase 0 (window source of truth) landed.**
Branch `context-window-compaction`. Implementing [`docs/context-compaction-plan.md`](docs/context-compaction-plan.md)
(WORKING PAPER — Phases 1–3 open). **Product decisions settled with the user:** D-a `chatCompactionEnabled`
defaults **ON** (silent drop-oldest is strictly worse than a visible summary; all new paths fail safe to
today's behaviour); D-b the transcript shows an **expandable** summary (auditable — the user can read the
checkpoint text), not just a marker. **Phase 0 scope (§L0 — fix G1):** chat/RAG prompt assembly now budgets
against the REAL launched context window (llama-server's `--ctx-size` = `manifest.recommendedContextTokens ||
settings.contextTokens`), not `settings.contextTokens` (which can diverge → too-tight trim wastes capacity,
too-loose risks the 400). **As-built:** new OPTIONAL `ModelRuntime.contextWindow(): number` accessor —
implemented on the three production runtimes (`LlamaRuntime` stores `opts.contextTokens`; `MockRuntime` and the
delegating `LadderRuntime` return theirs; window is fixed for a runtime's lifetime). Made OPTIONAL so the ~15
`ModelRuntime` test-literal stubs stay valid. `RuntimeManager.status()` surfaces it as the new
`RuntimeStatus.contextWindow?` (absent when not running). New exported helper `effectiveContextWindow(runtime,
settings)` in [`chat.ts`](apps/desktop/src/main/services/chat.ts) = `runtime.contextWindow?.() ?? settings.contextTokens`
(falls back when ≤0 or unreported); `generateAssistantMessage` + `generateGroundedAnswer` now budget through it.
**Data contract:** `RuntimeStatus.contextWindow?: number`; `ModelRuntime.contextWindow?(): number`. **No
behaviour change today** — for the shipped Qwen models `recommendedContextTokens` IS the launched window, so the
budget is the same or larger; this just stops trimming against the wrong number and gives Phase 1/2 the authoritative
window. **Verification:** `npm test` **1863 passed / 29 skipped** (+5: 3 `effectiveContextWindow`, 2 runtime
window/status); typecheck clean. **Files:** `shared/types.ts`, `runtime/{index,llama,mock,factory}.ts`,
`services/chat.ts`, `services/rag/index.ts`, tests `unit/runtime.test.ts` + `integration/chat.test.ts`. **Next:
Phase 1** — compaction core (`services/chat/compaction.ts`, the additive `messages.kind`/`covers_through_rowid`
migration, checkpoint writer/reader, summary user→assistant pair on both chat + RAG paths). NOT committed (awaiting
the user's go). **(prior entries below.)**_

_2026-06-19 — **Performance Wave P5 landed — the three remaining Medium findings shipped + CLOSED OUT.**
Branch `performance-tuning-continuation` (off the P1–P4 `performance-tuning` work). Three bounded,
behavior-preserving wins on hot/felt paths, one commit each:
- **DB-5** — `prepareCached(db, sql)` in [`db.ts`](apps/desktop/src/main/services/db.ts): a
  `WeakMap<Db, Map<sql, Stmt>>` compiling each distinct CONSTANT SQL once per connection (statements GC
  with the `Db`). Routed the hot per-turn callers: `chat.ts` listMessages/appendMessage/getConversation/
  listConversations, `collections.ts` resolveScope (2 prepares), the four `listDocuments` grouped
  counters. **Constraint:** dynamic-`IN(?,…)` prepares left on `db.prepare()` (caching them would leak /
  bind wrong arity). New unit test `tests/unit/db-prepare-cache.test.ts`.
- **ING-4** — the import-selection `walk()` now uses `readdirSync(dir, { withFileTypes: true })` (one
  syscall/entry instead of readdir + per-entry `statSync`). Symlinks (a `Dirent` doesn't follow them)
  fall back to `statSync` so the link-following expansion set is byte-identical; two new symlink tests
  (skip where the OS denies symlink creation — this Windows box does, EPERM). The **cross-call expansion
  cache was SKIPPED** (preflight↔import staleness risk for a modest gain).
- **FE-6** — paginated document preview. `DocumentPreview` gained OPTIONAL `totalSegments`/`nextOffset`;
  new `extractDocumentPreviewPage(offset,limit)` (default 50) slices the UNCHANGED
  `extractDocumentPreview`; `previewDocument` returns the first page, new `previewDocumentPage` IPC
  serves the rest behind a modal "Show more" + "Showing X of N". **The internal full-text consumers
  (skills, compare/translate, RAG) still call `extractDocumentPreview` and get every segment.**
  Trade-off: no partial parse, so subsequent pages re-extract + slice (bounded to one parse/interaction).
  New service + renderer tests.

**Data contracts:** `DocumentPreview.totalSegments?`/`nextOffset?` (optional; absent ⇒ whole doc) +
the new `previewDocumentPage(id, offset, limit)` IPC; `prepareCached`/`Stmt` exported from `db.ts`;
`extractDocumentPreviewPage`/`DEFAULT_PREVIEW_PAGE_SIZE` exported from `ingestion`. **Verification:**
`npm test` 1858 passed / 29 skipped, typecheck clean, `npm run build` clean. **Docs:** folded into
[`docs/architecture.md`](docs/architecture.md) "Performance — design record … Wave P5"; DB-5/ING-4/FE-6
tagged ✅ IMPLEMENTED inline + §6 in [`docs/performance-audit-2026-06-18.md`](docs/performance-audit-2026-06-18.md).
**Open residuals:** only the deferred-with-unmet-triggers items — P4b worker scan (trigger: cached
main-thread scan >100 ms routinely; measured ≤70 ms @10k), P4c ANN/sqlite-vec (rejected, D15), and the
behavior-sensitive renderer tail FE-5/FE-3/FE-4. **Next:** branch ready to merge into `performance-tuning`
/ `master`. **(prior entries below.)**_

_2026-06-19 — **Brand refresh BR6 landed — the wave is CLOSED OUT.** Branch `design-adjustments`. **The
HilbertRaum brand refresh is fully shipped (BR1–BR6).** **Why BR6:** discharge the doc-lifecycle rule —
fold the durable decisions into the binding guidelines and retire the plan file. **Docs fold:**
[`docs/design-guidelines.md`](docs/design-guidelines.md) gained **§13** ("Brand refresh — design record":
the one-line brand, §13.2 token decisions + the contrast facts + the pinning test, §13.3 mark
assets/component incl. the gate-safe CSS theme toggle + the relative-`src`/`file://` gotcha, §13.4 icon
pipeline, §13.5 verification + the nested-`policy.json` harness note); the LIVE token tables were updated
to match the code (§4.2 accent ramp → brand teal primitives + "retired" row; §4.3 `--link`/`--focus`/
`--accent`/`--row-selected-bar` → teal per theme + dark `--bg #0E1319`; §6 Primary button → teal fill +
dark-ink, Toggles → `--brand-teal-dark` track; the §4.2 contrast-fix note marked superseded). Historical
§11/§12 records left as-is (they describe past waves). **Plan file
`docs/brand-refresh-plan.md` DELETED** (full original in git history). **Final verification:** typecheck +
`npm run build` clean; full vitest from `apps/desktop` **1852 passed / 27 skipped**. **As-built (whole
wave):** `tokens.css` (brand primitives + role re-point + dark-bg nudge), `styles.css` (teal primary +
brand-img toggle, filled-control teal), `components/BrandMark.tsx` (+barrel), `App.tsx` + `WorkspaceGate.tsx`
(mark wired, `◈` removed), `chat/Waveform.tsx` (blue fallback → teal), `scripts/generate-icons.mjs`
(sealed-room geometry), `public/brand/*` + `public/icon.svg` + `build/icon.{svg,png,ico}` (artwork),
`shared/i18n` UNCHANGED (no copy changed), new `tests/unit/token-contrast.test.ts` +
`tests/renderer/BrandMark.test.tsx`. Captures in `docs/design-review/brand-refresh/{br2,br3,br4,br5}/`.
**Acceptance (plan §7) all met:** light+dark pass the contrast test; mark ink flips by background; dot
always teal; no teal text/links on a light surface; primary teal+dark-ink; teal stays rare; success
green / errors red; no CSP/offline/schema/IPC change; calm/premium. **Next:** the branch
`design-adjustments` is ready to merge to `master`. **(prior entries below.)**_

_2026-06-19 — **Brand refresh BR5 landed — package icon/favicon smoke; the produced icon set is correct
end-to-end.** Branch `design-adjustments`; plan
[`docs/brand-refresh-plan.md`](docs/brand-refresh-plan.md) phase BR5 of BR1–BR6 (WORKING PAPER — BR6 next,
the closer). **Scope:** verification only — no code changes (consumes the BR1 output). **ICO deep-validated:**
`build/icon.ico` = type 1, 7 entries; **every entry's embedded PNG decodes to its declared size**
(16/24/32/48/64/128/256, IHDR width/height match the directory entry, all PNG sigs valid); `build/icon.png`
is 512×512. Extracted the 256px + 32px entries and eyeballed them (captures in
`docs/design-review/brand-refresh/br5/`): the sealed-room mark (light-ink rounded square + teal dot on the
opaque `#0E1319` surface) renders cleanly at 256 and stays legible at 32 (taskbar size). **Window/taskbar
icon wiring confirmed:** `createWindow()` sets the BrowserWindow `icon` to `build/icon.png` (dev + Linux);
packaged Windows embeds `build/icon.ico` via electron-builder — so the OS icon shows the new mark. (The
document favicon `index.html href="/icon.svg"` is broken under the prod `file://` load, same root cause as
C-BR3, but it's IRRELEVANT — Electron uses the BrowserWindow icon, not the document favicon; left as-is.)
**Out-of-scope nicety noted, deferred:** the main-process pre-paint `backgroundColor` for dark is still
`#0f1115` (not the BR2-nudged `#0E1319`) — an imperceptible ~1-LSB flash colour; left untouched to respect
the renderer-only boundary. **Manual/deferred:** `npm run package:win` (network-touching, R2) for a
packaging owner. **Next: BR6** — write `walk-brand-refresh.mjs` (done; lives in-repo), fold the condensed
brand-refresh record into `design-guidelines.md` as a §-numbered section, finalize this file, and DELETE
the plan file per the doc-lifecycle rule. **(prior entries below.)**_

_2026-06-19 — **Brand refresh BR4 landed — full screen pass; every screen inherits the teal cleanly,
one leaked blue fixed.** Branch `design-adjustments`; plan
[`docs/brand-refresh-plan.md`](docs/brand-refresh-plan.md) phase BR4 of BR1–BR6 (WORKING PAPER — BR5/BR6
next). **Scope:** verification + one tiny renderer fix; no token/component changes were needed (the BR2
role swap propagated through `styles.css` as designed). **Only leak found + fixed:** a grep for hard hex
in the renderer surfaced ONE — [`chat/Waveform.tsx`](apps/desktop/src/renderer/chat/Waveform.tsx) (the
dictation visualizer) read `--accent` from computed style but had a hardcoded BLUE fallback `#6aa0ff`;
changed to the brand teal `#57d0a4` (only used if `--accent` ever resolves empty). Everything else is
token-driven — zero other hard colours in the renderer. **Progress bars** use theme-aware `--accent`
(light = dark teal `#1B7F5F` on a light track, dark = bright teal on a dark track — both ≥3:1; no
light-track weak-teal problem because light never uses the bright teal). **Eyeball walk
([`scripts/walk-brand-refresh.mjs`](apps/desktop/scripts/walk-brand-refresh.mjs), now ALL six screens ×
both themes × both locales EN/DE, captures in `docs/design-review/brand-refresh/br4/`):** Home (teal
adaptive primary), Chat (teal primary, NO mark in the content), Documents (teal "Import files", neutral
active sub-nav), AI Model (teal "Install AI engine"/"Download", amber warning banner, neutral status
badges, "Technical details" intact), Skills (teal "Import skill…", dark-teal "Enabled" switches), Settings
(segmented controls neutral, switch-on dark-teal track), Privacy (calm, no red/alarm). Confirmed against
§7 acceptance: teal restrained (no teal surfaces), **success stays green / warnings amber / errors red**,
no teal text on a light surface (links are the dark teal), marks correct + undistorted, dark-bg nudge
clean, DE labels fit. **Walk now loops locales** via `updateSettings({uiLanguage})` + reload (EN applies
correctly post-unlock; the gate itself is OS-locale-bound pre-unlock). **Verify:** typecheck + build
clean; full vitest from `apps/desktop` **1852 passed / 27 skipped** (no test changes — the Waveform
fallback isn't asserted). **Next: BR5** — package icon/favicon smoke (consumes BR1 output; confirm
`build/icon.ico` opens with all sizes + the favicon shows), then **BR6** — fold the condensed brand-refresh
record into `design-guidelines.md`, update this file, delete the plan file. **(prior entries below.)**_

_2026-06-19 — **Brand refresh BR3 landed — the `◈` placeholder is gone; the sealed-room `BrandMark`
is wired into the rail + gate.** Branch `design-adjustments`; plan
[`docs/brand-refresh-plan.md`](docs/brand-refresh-plan.md) phase BR3 of BR1–BR6 (WORKING PAPER — BR4
next). **Scope:** renderer-only (new component + two call sites + CSS + a test); no backend/IPC/schema
touch. **New component**
[`components/BrandMark.tsx`](apps/desktop/src/renderer/components/BrandMark.tsx) exports `BrandMark`
+ `BrandLockup` (barrelled in `components/index.ts`). **Theme selection is CSS, not JS** (plan §4.2
option 1): BOTH theme images render and a `[data-theme]` pair-toggle shows the correct one
(`.brand-img-light`/`.brand-img-dark` in `styles.css`) — so it works **pre-unlock in the gate**, which
can't read settings and follows the OS theme via the `data-theme` attribute set at startup
(`main.tsx`→`initTheme`). The dot is always teal; the square ink flips with the background. `BrandMark`
clamps size ≥16 (dev-warns below), bakes clear-space ≥ the dot diameter as wrapper padding, and is
decorative by default (labelled when `decorative={false}`). **CRITICAL asset-path gotcha (C-BR3):** the
production renderer is `loadFile`'d over **`file://`**, so an absolute `/brand/…` src resolves to the
filesystem root and renders a BROKEN image (caught by the eyeball walk; vitest can't see it). The src
must be **RELATIVE** (`brand/mark-on-light.svg`) — the renderer is a single `index.html` with no router,
so a relative path resolves next to it under both dev `http://localhost` and prod `file://`. (The
favicon `index.html` `href="/icon.svg"` has the same latent issue but isn't shown in the Electron window
frame; left as-is.) **Wiring:** rail brand slot (`App.tsx`) `◈ → <BrandMark size={24}/>` (keeps the
visually-hidden `.brand-name` + `title` for a11y); gate (`WorkspaceGate.tsx`) `◈ → <BrandMark size={36}/>`
above the existing "HilbertRaum Lite" edition line (mark decorative — the edition text announces the
brand). Dead `.brand-mark`/`.gate-brand-mark` glyph CSS removed; `◈` is gone from `src/` entirely.
**New guard:** [`tests/renderer/BrandMark.test.tsx`](apps/desktop/tests/renderer/BrandMark.test.tsx)
(12 cases): both theme assets chosen, relative src, min-size clamp + dev-warn, clear-space padding,
decorative vs labelled a11y, and an asset-existence check for `public/brand/*` + `icon.svg`.
`WorkspaceGate.test.tsx`/`rail-labels.test.ts` stay green (neither pins the mark). **Verify:**
typecheck + build clean; full vitest from `apps/desktop` **1852 passed / 27 skipped** (+12 BrandMark).
Eyeball walk ([`scripts/walk-brand-refresh.mjs`](apps/desktop/scripts/walk-brand-refresh.mjs), now at
`br3/`): rail mark flips light↔dark correctly; **gate mark flips correctly PRE-UNLOCK** in both themes
(dark-ink square on light, light-ink on dark), above "HILBERTRAUM LITE", with the teal+dark-ink primary.
**Eyeball-harness fix recorded:** the §11.4 recipe's `policy.json {encryption_required:true}` is **flat
and STALE** — the file is parsed NESTED at `policy.workspace.encryption_required`; a flat key is ignored
and the unpackaged (isDev) build falls back to `plaintext_dev`, bypassing the gate. The brand walk now
writes `{ workspace: { encryption_required: true, allow_plaintext_dev_mode: false } }` and drives the
gate by CSS/`input[type=password]` (locale-independent — the dev machine boots German). **Next: BR4** —
screen pass (Home/Chat/Documents/AI Model/Skills/Settings inherit cleanly; teal progress-bar contrast;
fix any leaked hard colours), full six-screen walk in both themes + both locales. **(prior entries
below.)**_

_2026-06-19 — **Brand refresh BR2 landed — design tokens swapped from blue to the sealed-room teal,
with a new contrast guard.** Branch `design-adjustments`; plan
[`docs/brand-refresh-plan.md`](docs/brand-refresh-plan.md) phase BR2 of BR1–BR6 (WORKING PAPER — BR3
next). **Scope:** `tokens.css` + the handful of `styles.css` rules that consumed the blue accent ramp,
the new contrast test, and two stale code comments — no backend/IPC/schema/CSP touch; the in-app `◈`
mark is still a placeholder (BR3 replaces it). **Brand primitives (new, theme-constant in `:root`):**
`--brand-teal #57D0A4` (the dot; primary fill; accent/link/focus on DARK), `--brand-teal-hover #48BE92`,
`--brand-teal-active #3DAE84`, `--brand-teal-dark #1B7F5F` (accent/link/focus on LIGHT + solid-control
fill carrying a white marker), `--brand-ink-dark #11171F`, `--brand-ink-light #E8EDF2`,
`--brand-surface-dark #0E1319`. **The old blue accent ramp (`--accent-700/600/500/300`) is fully
RETIRED** — every reference re-pointed or removed (grep-verified: zero `accent-NNN` / `2f6fed` / `4f8cff`
/ `2257c9` left in the renderer). **Role re-point:** `--accent`/`--link`/`--focus`/`--row-selected-bar`
→ `--brand-teal-dark` on light, `--brand-teal` on dark; `--bg` (dark) nudged `#0f1115 → #0E1319` via the
new primitive (§11 Q1 = YES). **Primary button (the one deliberate departure, §3.4):** explicit
`.btn.primary` = `--brand-teal` fill + `--brand-ink-dark` text in BOTH themes (≈9.98:1) with
hover/active = `--brand-teal-hover`/`-active`; NOT routed through `--accent` (which differs per theme).
**Filled controls:** checkbox/`<progress>` `accent-color` → theme-aware `--accent` (Chromium auto-picks
a contrasting checkmark); the custom **switch-on track** → `--brand-teal-dark` in BOTH themes because the
thumb is white `--n-0` (white on bright teal = 1.9:1 fails; on dark teal = 5.22:1 ✓). **Semantic
colours (success/error/warning) UNTOUCHED** — teal never replaces a status colour. **§11 answers
settled:** Q1 dark-bg nudge done; Q2 `--brand-teal-dark` kept at `#1B7F5F` (computes **4.92:1** on light
bg / 5.22:1 on white — comfortable AA headroom, no darkening needed). **New guard:**
[`tests/unit/token-contrast.test.ts`](apps/desktop/tests/unit/token-contrast.test.ts) parses `tokens.css`,
resolves every `var()` chain per theme, and computes WCAG contrast for all role pairings in BOTH themes
(text ≥4.5, UI ≥3) — it both verifies AND PINS the derived teal (incl. asserting the FORBIDDEN
bright-teal-on-white < 3:1, so the value can't drift off the bright hex). The repo had no contrast test
before — this is the most valuable new guard. **Measured ratios:** light link/focus/accent 4.92:1 (bg) /
5.22:1 (surface); dark 10.42:1 (bg) / 9.62:1 (surface); dark text on nudged bg 16.92:1; primary fill+ink
9.98:1 (hover 8.20, active 6.84); switch-on+thumb 5.22:1. **Verify:** `npm run typecheck` + `npm run
build` clean; full vitest from `apps/desktop` **1840 passed / 27 skipped** (+12 contrast cases;
`Theme.test.tsx`/`Components.test.tsx` unchanged — neither pins a hex). BR2 eyeball spot-check
([`scripts/walk-brand-refresh.mjs`](apps/desktop/scripts/walk-brand-refresh.mjs), Home/Chat/Settings both
themes, captures in `docs/design-review/brand-refresh/br2/`): teal reads calm/restrained, no teal
surfaces, switch-on + segmented controls correct, warning stays amber, dark-bg nudge clean. The full
six-screen / both-locale walk is BR4. **Next: BR3** — `BrandMark`/`BrandLockup` components (theme-pair
CSS toggle, gate-safe pre-unlock) wired into the rail + gate, remove the `◈`, + a `BrandMark.test.tsx`.
**(prior entries below.)**_

_2026-06-19 — **Brand refresh BR1 landed — sealed-room brand artwork vendored + the icon pipeline
rewritten.** Branch `design-adjustments`; plan [`docs/brand-refresh-plan.md`](docs/brand-refresh-plan.md)
phase BR1 of BR1–BR6 (still a WORKING PAPER — BR2 next). **Scope:** static brand assets + the
`generate-icons.mjs` pipeline only; **no UI wiring yet** (the `◈` placeholder in `App.tsx:211` /
`WorkspaceGate.tsx:155` stays until BR3), no tokens yet (BR2), no backend/IPC/schema/CSP touch.
**§11 open questions resolved** (defaults per the plan): dark-bg nudge `#0f1115→#0E1319` = YES in BR2
(drop only if a dark pairing regresses the new contrast test); `--brand-teal-dark` starts `#1B7F5F`,
final hex picked by the BR2 token-contrast test; **commit `build/icon.{png,ico}`** (matches repo;
packaging mustn't depend on running the generator); lockup-on-Home DEFERRED to the BR4 eyeball; og/PWA
assets SKIPPED (web-only). **Assets:** the user dropped the kit SVGs into
[`public/brand/`](apps/desktop/src/renderer/public/brand/); each was opened and the actual fill/stroke
confirmed before the mandatory semantic rename (kit names are background-inverted — `mark-dark.svg` is a
LIGHT square FOR dark bg). Final set in `public/brand/`: `mark-on-{light,dark}.svg` (in-app mark — dark
ink `#11171F` / light ink `#E8EDF2` square + always-teal `#57D0A4` dot), `lockup-on-{light,dark}.svg`
(mark + "Hilbert"+teal "Raum" wordmark), `mark-mono-{ink,white}.svg` (single-colour). The favicon →
[`public/icon.svg`](apps/desktop/src/renderer/public/icon.svg) (filename + `index.html` `<link>`
unchanged; theme-adaptive via an internal `@media prefers-color-scheme` that flips the square ink, dot
always teal); the app-icon → [`build/icon.svg`](apps/desktop/build/icon.svg) (light square + teal dot on
OPAQUE brand surface `#0E1319` — the OS icon carries its own background). **Pipeline rewrite:**
[`scripts/generate-icons.mjs`](apps/desktop/scripts/generate-icons.mjs) dropped the `diamond()` /
`ACCENT='#2f6fed'` geometry for a rounded-square (`arcTo` corners) + centre-dot render ported from the
512-unit `build/icon.svg`, on the opaque surface; KEPT the offline `@napi-rs/canvas` draw + hand-assembled
PNG-embedded `.ico` + `[16,24,32,48,64,128,256]` size set; regenerated + committed `build/icon.png` (512)
and `build/icon.ico` (7 sizes, validated: type 1, PNG sig at first dir offset). `electron-builder.yml`
needed NO change (filenames preserved). **Verify:** generator runs OFFLINE & writes a valid ico/png;
512 PNG eyeballed (light square + teal dot on `#0E1319`); brand assets + favicon copied into the build
output (`out/renderer/{brand/*,icon.svg}`); `npm run typecheck` + `npm run build` clean; full vitest from
`apps/desktop` **1828 passed / 27 skipped** (incl. `packaging.test.ts` green after the pipeline change —
its `@napi-rs/canvas` exclusion is unaffected). No screen-level visual change in BR1 → the Playwright
eyeball walk is deferred (BR5 = the dedicated icon/favicon-in-window smoke). **Next: BR2** — add brand
primitives to `tokens.css`, re-point `--accent*`/`--link`/`--focus`/`--row-selected-bar` to teal-derived
values, teal-fill+dark-ink primary button, optional dark-bg nudge, + a NEW `token-contrast.test.ts` that
pins every role pairing in both themes. **(prior entries below.)**_

_2026-06-19 — **Full-doc-skills Phase 4 landed — invoice adoption + the plan folded into the design
records + plan file deleted. The feature is now FULLY CLOSED OUT.** Branch `fix-use-full-doc-for-skills`.
**Why:** Phase 3 wired the seam into chat with bank-statement as the first adopter; the seam is general
(D44), so the closing phase proves it with a second content class and discharges the doc-lifecycle rule.
**Invoice handler** ([`analysis/invoice.ts`](apps/desktop/src/main/services/skills/analysis/invoice.ts),
D49 fast-follow): `INVOICE_INSTALL_ID = skillInstallId('app','invoice')`; `applies()` = a single in-scope
doc (`singleInScopeDocument`/`buildScopeFilter`, mirroring bank) + an invoice-shaped EN+DE keyword set
(substring-ambiguous tokens — `vat`/`ust`/bare `net` — deliberately avoided per the §1 DS17 caution).
`run()` auto-runs the READ-ONLY tools through the existing run seam (`runInvoiceExtraction` →
`runInvoiceTotalsValidation`) for their `skill_runs` lifecycle + ids/counts audit, then reads the
PERSISTED `invoices`/`invoice_line_items` rows (a local `loadInvoice` mirroring `invoice-run.ts`) and
computes the answer's figures via the PURE `validateInvoiceTotals` — the seams surface only counts.
**`runInvoiceCsvExport` is never imported** (export stays confirm-gated). The deterministic, localized
Markdown answer honours [`app-skills/invoice/SKILL.md`](app-skills/invoice/SKILL.md): leads with the
line-item count, surfaces any FAILED reconciliation check (line-items→net, net+tax→gross, tax-vs-rate)
**before** the headline gross, prints only the figures the invoice states (a field that couldn't be
parsed is left out — never invented). Real `[Sn]` citations are the document's leading source chunks
(the invoice schema records no per-figure source page, unlike `bank_transactions.source_page`; still
M2-safe — real chunks, never the synthesised total). Coverage is the same
`{ mode:'extract', chunksCovered=chunksTotal, chunksTotal, fullyChunked }` shape as bank (D48).
**Registration:** `registerBuiltinSkillAnalysisHandlers()` now registers BOTH bank + invoice;
`document-redaction` is intentionally NOT registered (it is an action skill — a one-line comment in the
barrel records why). **No chat-router change** — registering the handler is the entire wiring the
generic Phase-3 `askDocuments` path needs (R5: the bank, relevance, and coverage-extract paths are
byte-identical). **i18n:** `skills.invoiceAnalysis.*` added to en.ts + de.ts (parity), reusing the
shared `coverage.extract.*` meter + the Phase-3 `skills.analysis.refusePartial` refuse copy.
**Docs fold (doc-lifecycle rule):** architecture.md gained **§19** ("Full-document analysis for tool
skills", D44–D49 + the seam / per-message coverage contract / routing+refuse gate / bank+invoice
adoption); rag-design.md gained **§14.9** (the coverage half — per-message `CoverageInfo` is now
data-driven, cross-linked to §19); known-limitations.md records the **third coverage state** (a
`kind:tool` skill answers exhaustively over a fully-chunked doc or refuses, never partially). The plan
file **`docs/full-doc-skills-plan.md` is deleted** (full text in git history). **Tests:** 13 new in
[`skills-analysis-invoice.test.ts`](apps/desktop/tests/integration/skills-analysis-invoice.test.ts)
(handler-level: `applies()` pre-flight, exhaustive figures from rows, failed check surfaced before the
gross, figures quoted not invented, export never auto-run, coverage `fullyChunked` true/false, real
source citations, registry round-trip) + 3 new in
[`rag-skill-analysis-invoice.test.ts`](apps/desktop/tests/integration/rag-skill-analysis-invoice.test.ts)
(IPC-level over the REAL `askDocuments`: exhaustive path `coverage.mode==='extract'`+0 model calls+export
never auto-run, refuse path, relevance byte-unchanged). Suite **1828 green**; typecheck + production build
clean. **Next:** the feature is closed; the branch is ready to merge to `master`. **(prior entries
below.)**_

_2026-06-19 — **Full-doc-skills Phase 3 landed — the analysis handler is now WIRED into chat
(`askDocuments`) with the fully-chunked refuse gate.** Branch `fix-use-full-doc-for-skills`; plan
[`docs/full-doc-skills-plan.md`](docs/full-doc-skills-plan.md) Phase 3 of 4 (still a working paper —
**Phase 4 open**). **Why:** Phases 1–2 built the data contract + the standalone bank analysis handler
but nothing called it; a `kind:tool` skill's exhaustive whole-document tools were still bypassed on the
chat path. Phase 3 routes the turn to the handler. **App init:** `registerBuiltinSkillAnalysisHandlers()`
is now called once in [`main/index.ts`](apps/desktop/src/main/index.ts) (right after the startup skill
reconcile, BEFORE every `register*Ipc`) so the registry is populated before the first chat turn — no
import-time side effects, opt-in per skill (D49). **Chat wiring**
([`registerRagIpc.ts`](apps/desktop/src/main/ipc/registerRagIpc.ts)): after the turn skill resolves +
scope/filename auto-scope and BEFORE the `routeQuestion`/`generateGroundedAnswer` decision, a new branch
looks up `getSkillAnalysisHandler(skill.installId)` — **the registry IS the opt-in**, a registered
handler implies `kind:tool` (no separate kind check) — and when `handler.applies({ question, scope, db })`
takes over the turn. **Exhaustiveness gate (D45/R4):** a new `allInScopeDocsFullyChunked(db, scope)`
helper (alongside `documentsInScope`/`readyTreeCountInScope`, same `buildScopeFilter` style) reads
`documents.fully_chunked IS NULL` at TURN TIME (not a cached flag). **Not fully chunked ⇒ REFUSE:** a
fixed localized **`skills.analysis.refusePartial`** message (EN+DE) over the locked chat slot (one
`sendToken` → `appendMessage`), **NO model call, no partial answer, no tool run**, NULL coverage (a
refusal makes no breadth claim → renderer relevance fallback), skill stamped (A1); the copy points at
the existing **Documents → Re-index** affordance (same surface as `REINDEX_NEEDED_ANSWER` — no new UI).
**Fully chunked ⇒ `handler.run(ctx)`** with a production `SkillAnalysisContext`: `audit =
toSkillToolAudit(ctx.audit)` (the skills-run adapter, NOT a new sink — ids/counts only),
`readDocumentSegments` = the same `extractDocumentPreview`-backed faithful reader the skills-run IPC
injects (newline-preserving parser segments, not the overlap-collapsing `chunks`), `tr = tMain`, and the
chat slot's abort `signal` (Cancel stops the auto-run). The deterministic answer + real `[Sn]` citations
+ `coverage: result.coverage` (the extract/whole breadth — **D48**, what makes the meter show the truth)
are persisted via `appendMessage`, skill + `autoFired` stamped exactly as the relevance path. Both
outcomes acquire the slot via `withChatStream` (R3 — same lifecycle as the coverage-extract branch).
**R5:** when no handler is registered for the turn skill, or `applies()` is false (off-topic / multi-doc),
the whole block is skipped and the relevance + coverage-extract paths run **byte-unchanged** (verified by
the off-topic test). **No new capability reach:** the only content handles are the audit + segment reader
the skills-run IPC already uses; `runCsvExport` is never imported (export stays confirm-gated). **i18n:**
`skills.analysis.refusePartial` added to en.ts + de.ts (parity). **Tests:** 5 new in
[`rag-skill-analysis.test.ts`](apps/desktop/tests/integration/rag-skill-analysis.test.ts) driving the
REAL `askDocuments` IPC over an ingested statement + an enabled `app:bank-statement` skill — exhaustive
(real figures, `coverage.mode==='extract'`+`fullyChunked`, citations, 0 model calls, skill stamped),
refuse (fixed message, 0 model calls, 0 tool runs, no partial), relevance byte-unchanged for an off-topic
question, export never auto-run, single-locked-slot contract (token+done emitted, in-flight registry
cleared, exactly user+assistant rows). Suite **1812 green**; typecheck + production build clean. **Next —
Phase 4 (open):** confirm `invoice` registers a handler on the same seam (`document-redaction`
intentionally does not); fold this plan into [`architecture.md`](docs/architecture.md) "Skills — design
record" + the coverage half into [`rag-design.md`](docs/rag-design.md) §14; update
[`known-limitations.md`](docs/known-limitations.md) (third coverage state: tool-skill exhaustive); then
**delete the plan file**. **(prior entries below.)**_

_2026-06-19 — **Full-doc-skills Phase 2 landed — the analysis-handler seam + bank handler (NOT yet
wired into chat).** Branch `fix-use-full-doc-for-skills`; plan
[`docs/full-doc-skills-plan.md`](docs/full-doc-skills-plan.md) Phase 2 of 4 (still a working paper —
Phases 3–4 open). **Why:** a `kind:tool` skill's exhaustive, deterministic whole-document tools are
bypassed the moment a user just *asks* about a document (the chat path runs top-k RAG, not the tools).
Phase 2 builds the bridge a chat turn will (Phase 3) call: a per-skill **analysis handler** that
auto-runs the read-only tools and synthesises a grounded answer + honest coverage. **New module**
[`apps/desktop/src/main/services/skills/analysis/`](apps/desktop/src/main/services/skills/analysis/):
`types.ts` (`SkillAnalysisHandler` = `applies()` cheap pre-flight + `run(ctx)`; `SkillAnalysisContext`;
`SkillAnalysisResult { answer; citations; coverage }` — reuses the chat path's real `RetrievalScope`
and the shared `Citation`/`CoverageInfo`), `registry.ts` (`register`/`get` keyed by skill `install_id`,
**no import-time side effects** — precedent `tool-registry.ts`), `bank-statement.ts` (the
`app:bank-statement` handler), `index.ts` (`registerBuiltinSkillAnalysisHandlers()` — the EXPLICIT
registration Phase 3 calls once at app init). **Additive + standalone:** `registerRagIpc.ts`,
`router.ts`, `rag/index.ts` are **untouched** — nothing is wired into chat, so the relevance path stays
byte-identical (R5) trivially. **Handler behaviour:** `applies()` is conservative — a single in-scope
doc (`buildScopeFilter`, mirroring `registerRagIpc.documentsInScope`) **and** an analysis-shaped keyword
(EN+DE); off-topic keeps relevance; the refuse / not-fully-chunked routing gate is **Phase 3**. `run()`
drives the existing run seams (`runBankExtraction` → `runCashflowSummary` + `runBalanceValidation`, +
`runCategorization` only when the question is category-shaped) for their `skill_runs` lifecycle +
persistence + ids/counts audit, then computes the answer's **figures from the persisted rows** via the
PURE exported functions (`summarizeCashflow`/`reconcileBalances`/`categorizeRow`) — the seams surface
only counts. **`runCsvExport` is never imported** (export excluded by construction; stays confirm-gated).
The answer is deterministic, localized Markdown (precedent `analysis/listing-answer.ts`) honouring
`SKILL.md`: count → unreconciled rows BEFORE the total → totals (or an honest "no single total" on mixed
currency) → optional per-category breakdown → caveat; figures quoted, never invented. **Citations** are
real `chunks` rows narrowed to the transactions' `sourcePage` (`[Sn]`, M2-safe — never the synthesised
total). **Coverage** = `{ mode:'extract', chunksCovered=chunksTotal, chunksTotal, fullyChunked }`
(`documentChunkCount` + `documents.fully_chunked`; NULL → false), gating the "whole document" wording
(D48). **New i18n:** `skills.bankAnalysis.*` (EN + DE parity). **Tests:** 15 new in
[`skills-analysis-bank.test.ts`](apps/desktop/tests/integration/skills-analysis-bank.test.ts) — applies()
pre-flight (single doc / no doc / multi-doc / off-topic), exhaustive math, unreconciled-before-total,
mixed-currency no-total, figures-not-invented, export-never-auto-run, category-shaped gating, coverage
fullyChunked true/false, citations are real source chunks, registry round-trip. Suite **1807 green**;
typecheck + production build clean. **Next:** Phase 3 (router wiring in `registerRagIpc` + the
fully_chunked refuse-partial gate (D45) + i18n for the refuse notice). **(prior entries below.)**_

_2026-06-19 — **Full-doc-skills Phase 1 landed — per-message coverage is now data-driven (D48).**
Branch `fix-use-full-doc-for-skills`; plan [`docs/full-doc-skills-plan.md`](docs/full-doc-skills-plan.md)
Phase 1 of 4 (still a working paper — Phases 2–4 open). **Why:** a `kind:tool` skill answers a chat
question via top-k RAG, so the coverage badge was **hardcoded** `mode:'relevance'` at
`Transcript.tsx` regardless of what happened — making "if we analysed the full document, show that"
(D48) impossible to express. Phase 1 is **pure plumbing, zero behaviour change**: it persists a real
`CoverageInfo` per assistant message so later phases can render the truth. **New data contract:**
**`messages.coverage_json`** — additive + nullable `ensureColumn` migration ([`db.ts`](apps/desktop/src/main/services/db.ts),
after `auto_fired`). Holds a JSON-serialized `CoverageInfo` (mode + sections covered/total — counts/mode
only, never content); NULL = legacy/pre-migration row OR a turn that recorded no coverage. An older app
ignores the column. **Round-trip** in [`chat.ts`](apps/desktop/src/main/services/chat.ts): `appendMessage`
gained `coverage?: CoverageInfo | null` → `serializeCoverage` (tolerant — a stringify fault degrades to
NULL, never blocks the append); `rowToMessage` → `parseCoverage` (NULL/malformed → undefined; the three
required keys coalesced so a partial payload still satisfies the contract), mirroring the existing
`citations_json` model. **Type:** `Message.coverage?: CoverageInfo` in [`shared/types.ts`](apps/desktop/src/shared/types.ts).
**Renderer:** [`Transcript.tsx`](apps/desktop/src/renderer/chat/Transcript.tsx) now reads
`m.coverage ?? { mode:'relevance', chunksCovered:0, chunksTotal:0 }` — every pre-migration message AND the
unchanged relevance path render **byte-identically** (R5). The relevance path persists no coverage (stays
NULL). **Tests:** 4 new — round-trip + no-coverage→undefined + malformed→undefined in
[`chat.test.ts`](apps/desktop/tests/integration/chat.test.ts); a data-driven `extract` coverage renders +
NULL→relevance fallback in [`Coverage.test.tsx`](apps/desktop/tests/renderer/Coverage.test.tsx). Suite
**1792 green**; typecheck + production build clean. **Next:** Phase 2 (analysis-handler seam + bank
handler) — NOT started. **(prior entries below.)**_

_2026-06-18 — **New chat model added: Qwen3.5 4B (UD-Q4_K_XL)** (user request). Manifest-only
addition (model-policy.md "adding a model is manifest-only"):
[`model-manifests/chat/qwen3.5-4b-ud-q4kxl.yaml`](model-manifests/chat/qwen3.5-4b-ud-q4kxl.yaml).
Quant **UD-Q4_K_XL** (unsloth Dynamic 2.0 — better quality than plain Q4_K_M at ~same footprint;
user decision). Apache-2.0; `supports_thinking_mode: true` (Qwen3.5 thinks by default → Deep applies);
~2.9 GB, 8 GB-RAM tier. **Real SHA-256 captured** by fetching the upstream weight 2026-06-18
(`b252c5610a42ca82d20fe2a12813e9d069eed89292907e26c783eeb0bc961bc7`; bytes matched `download.size_bytes`
exactly = 2,912,109,728) and promoted into both the top-level `sha256` and `download.sha256`. Weight
was hashed from a TEMP copy and deleted — **not committed** (hard rule: no weights in git). **NOT
auto-recommended** (`recommendation_rank: 0`, `recommended_profiles: []`) and **not bundled**
(`bundled_on_preconfigured_drive: false`) — not yet benchmarked. ⚠️ **RUNTIME-COMPAT UNVERIFIED:**
runtime is pinned to llama.cpp **b9585** (2026-06-10); Qwen3.5 is a newer architecture and may not load
until the pin is bumped in `runtime-sources.yaml` — appears in the list but start could fail. Upstream
is a vision model; the `.gguf` runs text-only (no mmproj shipped), which is all the chat pipeline uses.
**Tests:** `models.test.ts` green (51) — the suite walks the real manifests dir, so the new file
parses+validates. **Docs:** row added to `docs/model-policy.md`. **(prior entries below.)**_

_2026-06-18 — **document-redaction is the first skill to opt into auto-fire (S13b D6).** A user
reported "I want to anonymize my attached document" not auto-firing the redaction skill even with the
`skillsAutoFireEnabled` opt-in on and a document selected. Root cause: the **D6** author-opt-in was
never set — `document-redaction/SKILL.md` had keywords but no `triggers.autoFire`, so the candidate
set in `resolveAutoFireSkill` was empty (no bundled skill declared it). **Fix:** added
`triggers.autoFire: true` to [`app-skills/document-redaction/SKILL.md`](app-skills/document-redaction/SKILL.md).
Now, with the user opt-in on, "anonymize/redact"-style turn (keyword, score 2) over a **selected**
pdf/plain/markdown document (in-scope-doc MIME, +1) = 3 clears `AUTOFIRE_SCORE_THRESHOLD` and fires.
"Selected" = in the conversation's persisted scope, which `inScopeDocSignals` resolves main-side
(§22-C4) — verified: the same phrase with no doc in scope (score 2) does NOT fire. **No code/contract
change** — only the skill manifest + docs; the autoFire flag doesn't enter the eval harness scoring, so
the `threshold-3` D1 gate stays **100% precision** on the S13a corpus. **Tests:** 4 new in
[`skills-autofire.test.ts`](apps/desktop/tests/integration/skills-autofire.test.ts) exercising the REAL
redaction skill end-to-end (fires on the reported phrase + a selected PDF; inert keyword-only,
non-redactable MIME, and opt-in-off) — file 17→21, suite green. **Docs:** architecture §18 safe-merge
paragraph corrected (the property now rests on the default-false opt-in alone, not on "no skill
declares autoFire") + a "first opted-in product skill" note added. **(prior entries below.)**_

_2026-06-18 — **Three minor UI adjustments (Models screen + Document preview).**
(1) **Models screen** (`renderer/screens/ModelsScreen.tsx`): the "Other models" picker (non-active
chat models) now sorts installed models first — `isInstalled` ranks `installed`/`running`/`ready`
ahead of the rest, stable within each group (manifest order preserved). Already-usable models lead;
not-yet-downloaded ones sink. (2) **Translated/Markdown documents render formatted in preview**
(`renderer/screens/DocumentsScreen.tsx` `PreviewModal`): per-page extracted text was rendered as plain
text, so a machine-translated `.md`'s `**bold**`/lists showed raw. The segment text now renders via
`AssistantMarkdown` (same component+sanitizer as chat answers/summaries) when `preview.mimeType`
contains `markdown`; non-markdown formats keep the plain `pre-wrap` `.preview-text`. (3) **Extracted
text collapsed behind a disclosure**: for large documents the per-page list buried the summary. The
segments now live in a `<details className="doc-summary doc-rawtext">` (reusing the summary container
chrome) titled "Document text" (`docs.previewModal.documentText`, en+de) — `open` by default ONLY when
there's no summary, so the preview never looks empty. New CSS `.doc-rawtext .doc-summary-body
.preview-segment { margin-bottom: 0 }`. **No data-contract changes.** Typecheck + build clean; full
suite **1784 passed / 27 skipped** (unchanged). **(prior entries below.)**_

_Last updated: 2026-06-18 — **Wave P4 real-drive measurement CLOSED (branch `performance-tuning`).**
The one open P4 item — "real E5-runtime numbers PENDING the PAID drive" — is done now that the real
HilbertRaum drive (D:, real `multilingual-e5-small-q8` + the b9585 `llama-server`) is attached. Two
drive-gated manual benchmarks (no production code changed): (1) `tests/manual/resident-cache-bench.test.ts`
gained a `RESIDENT_BENCH_DIR` override + multi-size loop so the bench DB — and thus the cold-build
SELECT — lives on real USB I/O; (2) new `tests/manual/resident-cache-real.test.ts` embeds a realistic
corpus through the **real E5 sidecar**, stores genuine E5 vectors via the production codec on the drive,
and times cold build + warm cached scan + full `searchText` (E5 query-embed + scan). **Findings:** scan
scaling on the drive (synthetic vectors — the scan is data-independent: N dot-products of 384-dim Float32
+ sort) warm 13.6/52.5/164.6/605 ms @ 5k/10k/30k/100k, cold rebuild 33 ms…1.48 s — **matching the prior
mock projection within noise** (mmap, DB-2, keeps the cold build off USB cheap). Real-E5 end-to-end:
@2k chunks (a realistic ≤~10-doc corpus) warm scan **5.8 ms**, full query **17.8 ms** — the E5
query-embed round-trip **dwarfs the scan 3.1×**; @10k warm scan 73 ms, full query 102 ms (scan ≈ embed,
both dwarfed by the reranker's seconds). **DECISION CONFIRMED (no change):** at realistic MVP corpora the
synchronous scan is NOT the bottleneck, so P4b (worker) + P4c (ANN) stay deferred with the documented
~100 ms trigger; the 100k bound (~605 ms) remains the narrowed D15 cliff. **Docs:** real numbers folded
into `docs/architecture.md` "Performance — design record … Wave P4" (measurement + why-deferred),
`docs/performance-audit-2026-06-18.md` STATUS banner, and this file's P4 entry — every "PENDING the PAID
drive" marker retired. **Verification:** both manual benches green on D:; the gated tests stay skipped in
the normal suite. **(prior P4-ship entry below.)**_

_2026-06-18 — **Performance audit Wave P4 SHIPPED (branch `performance-tuning`) — the
final, deferred wave; the documented MVP deferral D15.** RAG-1/RAG-6: the synchronous main-thread
vector scan (`VectorIndex.search`, `apps/desktop/src/main/services/embeddings/index.ts`) no longer
re-`SELECT`s every `vector_blob` (~150 MB at the heavy 100-doc bound) and re-decodes it per query.
**Shipped (P4a, one feature):** a **process-resident decoded-vector cache**
(`embeddings/resident-cache.ts`) — every stored vector is decoded **once** into a
`Map<chunkId, Float32Array>` (one cache per open `Db`, `WeakMap`-keyed) and reused across queries. The
`search` SQL keeps the **byte-identical scope-filtered WHERE** but projects only `chunk_id` (no blob
read), then looks each vector up in the resident map — zero per-row allocation, zero re-decode. **Behind
the unchanged `VectorIndex.search(queryVector, topK)` signature** (so `rag/index.ts retrieve()` + every
scope filter are untouched); ranking byte-identical (same `dotProduct`, same sort); the
dimension-mismatch + truncated-blob skips preserved. The vector↔BLOB codec moved to
`embeddings/codec.ts` to break the `index ↔ resident-cache` import cycle (re-exported from the barrel).
**Invalidation contract (highest-risk surface, belt-and-suspenders):** (1) a cheap whole-table
`(COUNT(*), MAX(rowid))` **signature** recomputed at the top of every search — rebuilds on any mutation
incl. direct SQL writes (so test seeding stays correct); (2) explicit `invalidateResidentVectors(db)`
at the **3 `embeddings` write sites** (`ingestion/index.ts` finalize-insert + reindex chunk-phase delete
+ `deleteDocument`) — closes the delete-max-rowid-then-equal-reinsert blind spot; (3) `purgeResidentVectors(db)`
on **workspace LOCK** (`registerWorkspaceIpc`, beside `embedder.suspend()`) — SECURITY: the vectors
derive from chunk text and must not linger in RAM after the vault re-encrypts (the signature can't catch
this — the table is unchanged). No embedder-switch purge needed (per-`Db`, per-chunk, model-agnostic;
the SQL model-id filter scopes results; unlock reopens the `Db` → fresh cache). **MEASURED — confirmed
on the PAID drive (D:, b9585):** scan scaling on the real drive (synthetic vectors — scan is
data-independent) warm cached scan 13.6 ms @ 5k chunks, 52.5 ms @ 10k, 164.6 ms @ 30k, 605 ms @ 100k
(1.2–1.7× vs decode-every-query; cold rebuild once per mutation 33 ms@5k…1.48 s@100k) — tracks the mock
projection within noise; real-E5 end-to-end on the drive @2k chunks warm scan 5.8 ms / full query (E5
embed + scan) 17.8 ms (query-embed dwarfs the scan 3.1×), @10k warm scan 73 ms / full query 102 ms. The
residual is now SQLite→JS row marshalling + the dot-product scan + sort, **not** decode. **DECISION — P4b (off-main-thread
worker) + P4c (ANN) DEFERRED with the number:** at realistic MVP corpora (≤~10k chunks ≈ ≤~10–50 docs)
the scan is ≤~50 ms (fine, dwarfed by the query-embed await + reranker); only the 100k upper bound bites.
P4b's trigger = "a representative corpus measures the cached main-thread scan over ~100 ms routinely"
(the resident cache is its `SharedArrayBuffer` substrate); P4c/sqlite-vec stays rejected as a **native
loadable extension** against the no-native-build / portable-packaging rule (D15). **New data contracts:**
new exports `getResidentVectors`/`invalidateResidentVectors`/`purgeResidentVectors` (+ the cache
invalidation contract above); `encodeVector`/`decodeVector` now live in `embeddings/codec.ts`
(re-exported from the `embeddings` barrel — callers unchanged). **Docs:** folded into
`docs/architecture.md` "Performance — design record … Wave P4"; `docs/rag-design.md` §6 (resident cache)
+ §12.2 **D15 → partially resolved**; audit RAG-1/RAG-6 → ✅ IMPLEMENTED, §6 Wave P4 checked off, STATUS
banner + §3.2 theme updated. **New tests:** `tests/integration/resident-cache.test.ts` (+8: ranking
equivalence vs a from-scratch oracle, signature catches direct INSERT/DELETE after build, invalidate +
lock-purge rebuild, scope-filter composition incl. archived, ingestion import→reindex→delete lifecycle,
offline guarantee through the cached path) + a gated manual `tests/manual/resident-cache-bench.test.ts`.
**Verification:** full suite **1784 passed / 26 skipped** (+8, +1 skipped manual bench), typecheck +
build clean. Real E5-runtime numbers now CLOSED on the PAID drive (see the dated closeout entry above).
**NEXT ACTION:** Wave P4 core done — the
perf audit's four waves are all shipped. Still open (out of P4 core, tracked in the audit): RT-9
(byte-stable plain-chat fence), the deferred P2 renderer items (Composer/`input` move, `DocRow`,
FE-5 windowing), and the audit Low items. **(prior P3 entry below.)**_

_2026-06-18 — **Performance audit Wave P3 SHIPPED (branch `performance-tuning`).**
Pipeline throughput & latency on the two hottest operations (import a document, ask a question) plus
runtime-startup knobs (audit `docs/performance-audit-2026-06-18.md` §6 Wave P3). Unlike P2 (pure
memoization), several items are **structural**, each preserving a stated correctness contract.
**Shipped (one commit per finding id):** (1) **RAG-1 (High, slice only)** — `VectorIndex.search` uses
a new `dotProduct` helper instead of `cosineSimilarity`: stored + query vectors are L2-normalized
(`e5.ts` `l2normalize`, mock too) so cosine == dot, dropping the two per-row norm accumulators (~2×
fewer FLOPs/row); ranking identical to float tolerance. **The ANN/worker scan stays Wave P4 (D15).**
(2) **RT-5 (Low)** — `waitForHealthy` backs off from 50 ms ×2 up to the `healthIntervalMs` cap
(default 250) instead of a fixed 250 ms poll; overall timeout budget unchanged. (3) **RT-4 (Medium)**
— the embedder sidecar now sets `--batch-size`/`--ubatch-size` to `max(ctx, 2048)` (was the
embedding-mode 512 default), packing multiple of a 32-input batch's sequences per ubatch. **VERIFIED
on the pinned b9585 binary** (PAID smoke drive attached): with both flags at 2048 the "n_batch (2048)
> n_ubatch (512) … setting n_batch = n_ubatch = 512" downgrade warning does NOT fire and a multi-input
`/v1/embeddings` request returns correctly. Arg-assertion test added. (4) **RT-3 (Medium)** —
`buildModelList` gains an additive **`onlyVerifyModelId`**; the `listModels` IPC gains an optional
**`lazyVerify`** arg. The WorkspaceGate (chat path) passes `lazyVerify:true` → only the active model
is SHA-256-hashed on a cold cache (the others reported `installed` unhashed, display-only); the Models
screen omits it and hashes the full set. §7.4 gate intact — `startModelRuntime` re-verifies the model
it launches; a live cached hash is still served for free. (5) **RT-2 (Medium, correctness-critical)**
— the stable grounding rules + preface moved from the per-turn USER message into a new cacheable
**`GROUNDED_SYSTEM_PROMPT`** (= `BASE_SYSTEM_PROMPT` + rules); the user turn keeps only question +
excerpts (+ the skill fence, which STAYS in the user turn as untrusted reference text). ~58 approx
tokens of rules now sit in the always-reused `cache_prompt` prefix instead of re-prefilling every
documents turn. Precedence preserved/strengthened (rules in system ≥ user), `[Sn]` + no-context
contracts untouched; a test asserts the system prefix is byte-stable across two turns. (6) **ING-5
(Medium)** — new Electron-free `ocr/pipeline.ts` `pipelinePages` renders page N+1 WHILE page N
recognizes (1-deep look-ahead); recognitions stay serial + in order, memory bounded to one extra PNG;
ordering/progress/cancellation unchanged. (7) **ING-3 (High, highest risk, done LAST)** —
`processDocument` split at the already-DB-mediated chunk↔embed boundary into **`prepareDocument`**
(parse+chunk) + **`finalizeDocument`** (embed+mark); `processDocument` is now their composition (so
reindex/OCR/materialize are behavior-identical). The import loop runs `prepareDocument(N+1)` WHILE
`finalizeDocument(N)` embeds — **embeds are NEVER parallelized** (the sidecar is the single contended
resource); only parse(N+1) overlaps embed(N). Per-file statuses/ordering/error-isolation, the DB-1
per-phase transactions, and lock-mid-job all preserved (look-ahead drained + de-registered on a lock
break). **New / changed data contracts:** new exports `prepareDocument`/`finalizeDocument`/
`PreparedDocument`; `buildModelList({ onlyVerifyModelId })` (additive, behind the locked `listModels`
contract); `listModels(lazyVerify?)` IPC arg; the grounded system prompt is now
`GROUNDED_SYSTEM_PROMPT` (exported); embedder spawns with `--batch-size`/`--ubatch-size`. **Docs:**
folded into `docs/architecture.md` "Performance — design record … Wave P3" + §17 (a)→implemented, and
`docs/rag-design.md` §8 (grounded prompt split); audit P3 items tagged **✅ IMPLEMENTED**, §6 Wave P3
checked off, STATUS banner updated. **New tests:** `dotProduct` ranking equivalence (embeddings.test),
e5-embedder RT-4 arg assertion, RT-3 lazy/full hashing (models.test, +WorkspaceGate passing lazy),
RT-2 rules-in-system + byte-stable-prefix (rag.test, skills-turn.test updated), `ocr-pipeline.test`
(ordering/overlap/one-ahead/cancel), ING-3 mid-batch-failure isolation (docs-ipc.test).
**Verification:** full suite **1776 passed / 25 skipped** (+16), typecheck + build clean.
**NEXT ACTION:** Wave P4 — the off-main-thread / ANN vector scan (RAG-1/RAG-6 beyond the dot product,
the D15 trigger). Still deferred from P2: Composer/`input` move, `DocRow` extraction, FE-5 windowing.
**(prior P2 entry below.)**_

_2026-06-18 — **Performance audit Wave P2 SHIPPED (branch `performance-tuning`).**
Renderer responsiveness on the CPU-only target (audit `docs/performance-audit-2026-06-18.md` §6 Wave
P2) — the chat transcript and the Documents screen re-did O(list) work and re-parsed Markdown on a
40 ms / 400 ms cadence, competing with token generation. All behavior-preserving (no visible UI
change except less jank) save the one streaming decision below. **Shipped (one commit per finding):**
(1) **FE-1 (High)** — streaming no longer re-parses the whole transcript. Each persisted turn is a
memoized `MessageBlock` (React.memo, keyed by id) and `AssistantMarkdown` is itself `React.memo`'d
(keyed by text); the live answer now **renders as PLAIN TEXT** (`.msg-content` pre-wrap) during the
stream with the full Markdown parse run ONCE on completion (the only visible effect: raw `**markers**`
show during streaming, snap to formatted on completion — audit-sanctioned). `lastAssistantId` is
`useMemo`'d; the scroll-to-bottom effect is gated on an `atBottomRef` (also the cheap half of FE-5).
(2) **FE-2 (High)** — DocumentsScreen `useMemo`s the derived collections, `sourcesById`,
`visibleDocs` (section filter + recent ordering; `inSection` now a pure module helper),
`anyActive`/`staleDocs`, and the four rail counts collapsed into one bucketing pass. (3) **FE-7
(Medium)** — both import watchers (`watchJob`, `watchAttachJob`) poll only the small `getImportJob`
on the 400 ms tick and refresh the full list (+ attachments) only when `completed + failed` changes
(a file finished) and at completion — the ModelsScreen download-poll pattern; the list updates at
file-completion granularity instead of re-deriving 2.5×/s. (4) **FE-3/FE-4 (Medium)** — `Transcript`
+ `ConversationList` `React.memo`'d with stable handler identities via a new `useEventCallback`
(latest-ref) wrapper + `useMemo`'d `emptyState`, so a keystroke/flush no longer re-renders them;
`ConvRow` extracted + memoized so opening one ⋯ menu doesn't re-render every row. **New / changed
data contracts:** none on the wire — `getImportJob` (existing IPC) is now the per-tick poll, with
`listDocuments` refreshed on a status transition instead of every tick (behavioral: import list
updates at file-completion granularity). **DECISION (recorded):** the live streaming answer is plain
text until completion (kills the O(n²) per-flush Markdown re-parse). **Deferred within P2** (under the
behavior-preserving mandate; tracked in the audit): the rest of FE-3 (memoize `Composer` + move
`input` into it — needs the footer handlers stabilized), the FE-4 `DocRow` extraction (~25-prop row,
high stale-closure surface), and **FE-5** list windowing (only the scroll-thrash half landed).
**Docs:** lasting decisions folded into `docs/architecture.md` "Performance — design record (perf
audit 2026-06-18, Wave P2)"; audit P2 items tagged **✅ IMPLEMENTED** (FE-5 ⏳ PARTIAL) and §6 Wave P2
checked off. **New renderer tests:** `TranscriptMemo` (live answer never hits react-markdown; a prior
message isn't re-parsed when only `streamText` changes) + a DocumentsScreen FE-7 poll test
(`getImportJob` each tick, `listDocuments` only on a completion transition). **Verification:** full
suite **1760 passed / 25 skipped** (+3), typecheck + build clean. **NEXT ACTION:** Wave P3 (ING-3/5
pipelines, RT-2/RT-3, RAG-1 dot-product) when picked up; the deferred P2 sub-parts (Composer/input,
DocRow, FE-5 windowing) tracked in the audit. **(prior P1 entry below.)**_

_2026-06-18 — **Performance audit Wave P1 SHIPPED (branch `performance-tuning`).** Six
high-ROI, low-risk, constant-factor/batching wins from `docs/performance-audit-2026-06-18.md` §6,
targeting the two hottest user operations (import a document, ask a question) on the CPU-only USB
target — no behavior change. **Shipped (one commit per finding):** (1) **DB-1 (Critical)** —
`processDocument` was the lone batch writer not wrapping its inserts; the delete-then-insert chunk
phase and the embedding-insert phase are each now one `BEGIN…COMMIT` (`ROLLBACK` on throw,
`tree-build.ts` pattern), the async `embedder.embed()` await kept OUTSIDE the txn (`node-vectors.ts`
precedent). Collapses ~3000 fsync'd auto-commits/doc (1000 chunks ×(insert+FTS trigger) + 1000
embeddings) → 2. (2) **DB-2 (High)** — after WAL, `openDatabase` now sets `synchronous=NORMAL`,
`busy_timeout=5000`, `mmap_size=268435456`, `cache_size=-16000`, `temp_store=MEMORY`. (3) **DB-4/6/7
(Medium)** — additive `CREATE INDEX IF NOT EXISTS` (after `ensureColumn`): `idx_embeddings_model`,
`idx_extract_type_nv(record_type, normalized_value)`, `idx_documents_status`,
`idx_bank_transactions_category`; **`run_id` indexes deliberately OMITTED** — `run_id` is only ever
INSERTed, never joined/filtered (would be pure USB write-amplification). (4) **RAG-2/ING-1 (High)** —
compare mode-(b) now decodes doc-B's `(id,text,chunk_index,vector)` ONCE into a resident array and
cosines in memory (local `nearestB()` reproducing `VectorIndex.search` ranking) instead of
re-`search`ing + re-decoding all of doc-B per A-chunk and re-fetching B's text per window; mirrors
`alignNodes` (`compare.ts`). (5) **DB-3/ING-2 (High)** — `listDocuments` per-row COUNT +
per-indexed-row COUNT+JOIN (1+2N queries, polled at 400 ms during import) → two `GROUP BY document_id`
queries into Maps (mirrors the memberships join beside it); removed the now-unused `chunksEmbeddedUnder`
helper. (6) **RT-1 (High)** — chat sidecar left `--batch-size`/`--ubatch-size` at llama-server's 512
default, throttling prompt prefill (the dominant TTFT cost, 3.5–15 s CPU per Skills §17); new opt-in
`LlamaServerOptions.physicalBatchSize` (emitted by `buildArgs`) set by the chat runtime to
`min(contextTokens, CHAT_MAX_PHYSICAL_BATCH=2048)` — embedder/reranker untouched (they set their own
batch via `extraArgs`); new `llama-runtime.test.ts` arg assertion mirrors the reranker test. **New /
changed data contracts:** PRAGMA `synchronous=NORMAL` (WAL-safe durability change — only the last txn
is at risk on OS/power loss, never corruption) + the four other PRAGMAs; four new indexes; ingestion
writes are now atomic per phase; new sidecar arg `physicalBatchSize` ⇒ chat spawns with
`--batch-size`/`--ubatch-size`. **Docs:** lasting decisions folded into `docs/architecture.md`
"Performance — design record (perf audit 2026-06-18, Wave P1)"; the audit report is RETAINED (findings
record) with each P1 finding tagged **✅ IMPLEMENTED** and §6 Wave P1 checked off. **Verification:** full
suite **1757 passed / 25 skipped** (+1, the RT-1 arg test), typecheck + build clean. **NEXT ACTION:**
Wave P2 (renderer responsiveness — FE-1/FE-2/FE-7/FE-3-5) when picked up; Waves P3/P4 tracked in the
audit §6._

_(prior) 2026-06-17 — **Skills Phase S13c SHIPPED — surprise-mitigation UX; S13 (auto-fire) is
now FULLY CLOSED.** The S13b mechanics are now reachable by a user, behind the two ratified D3/D4
surfaces, both EN/DE. **Shipped:** (1) **The opt-in toggle (D4):** a Switch in **Settings → Skills**
([`SkillsTab.tsx`](apps/desktop/src/renderer/screens/settings/SkillsTab.tsx)) reads/writes the existing
`skillsAutoFireEnabled` setting through the shared `updateSettings` patch path — **off by default**,
hidden until settings load (never implies an unconfirmed state). This is the ONLY control that makes
S13b reachable; until it ships auto-fire could not be enabled. (2) **The per-turn undo (D3):** an
auto-fired turn stamps an **additive, nullable `messages.auto_fired` column**
([`db.ts`](apps/desktop/src/main/services/db.ts)) — set only when the auto-fire path placed the skill
AND the fence fit (the §22-A5 stamp-only-when-fenced precedent), so it lines up 1:1 with the glyph and a
deleted skill drops glyph+undo together. Threaded additively via `TurnSkill.autoFired` (set by
`resolveAutoFireSkill`) → `appendMessage`/both generators (`chat.ts` `generateAssistantMessage`,
`rag/index.ts`) → `Message.autoFired` (read back in `rowToMessage`). The [`Transcript`](apps/desktop/src/renderer/chat/Transcript.tsx)
glyph on an auto-fired turn reads **"Answered with `<skill>`"** + a one-click **"answer without it"** on
the LAST assistant turn; tapping it ([`ChatScreen`](apps/desktop/src/renderer/screens/ChatScreen.tsx)
`onAnswerWithoutSkill`) re-runs the SAME question with the skill **explicitly cleared
(`skillInstallId: null`)** — the explicit per-turn clear stamps no skill AND suppresses a re-auto-fire.
Reuses the regenerate path in BOTH modes; `askDocuments` gained a symmetric `regenerate` arg (drop the
last assistant turn, re-use the existing last user turn — never a duplicate user row). Skill title
localized via `skillI18n.ts`. **DECISION (recorded):** the renderer learns a turn was auto-fired via the
additive `auto_fired` column (privacy-safe boolean, mirrors the additive-schema + stamp-only-when-fenced
precedents) — chosen over "show the undo on every skill turn" (which would surface it on explicit picks,
contradicting D3). **Safe-merge property INTACT:** default-off setting + no bundled skill declaring
`triggers.autoFire` ⇒ a fresh install behaves identically to pre-S13. **§6/§14 ceilings unchanged:** the
undo is a re-run not a new capability; no auto-fire path logs the question or adds an audit event; the
S12 sentinel guard still holds. **Docs:** `docs/skills-s13-plan.md` **folded into
`architecture.md` "Skills — design record" §18 (+ §6 cross-ref + legend rows) and DELETED** (doc-lifecycle
rule; original in git history). **New contracts:** `messages.auto_fired` (additive nullable);
`Message.autoFired` / `TurnSkill.autoFired`; `skillsAutoFireEnabled` is now user-toggleable;
`askDocuments(convId, question, skillInstallId?, regenerate?)`. Full suite green (**1756 passed / 25
skipped**, +9), typecheck + build clean. **NEXT ACTION: none — S13 is done.** Auto-fire is now
user-enableable (default off) with a visible glyph + a per-turn undo; product opt-in (a bundled skill
declaring `triggers.autoFire`) remains a later deliberate choice._

_(prior) 2026-06-17 — **Skills Phase S13b SHIPPED — auto-fire MECHANICS, behind a default-off
opt-in (INERT in production until S13c).** The ratified D1–D6 contract (§2.1) is now built; auto-fire
fires only when a user opts in AND a skill declares it AND no skill is otherwise set. **Safe-merge
property: with the new `skillsAutoFireEnabled` setting defaulting FALSE and no S13c toggle yet, S13b
changes NOTHING in production behaviour** — `resolveAutoFireSkill` is a true no-op when off, and no
bundled app skill declares `triggers.autoFire` yet, so the candidate set is empty regardless. **Shipped:**
(1) **Schema (D6):** `triggers.autoFire?: boolean` in [`skill-manifest.ts`](apps/desktop/src/shared/skill-manifest.ts)
— additive + lenient (only boolean `true` opts in; non-boolean noted+clamped to false; absent/false →
`undefined` so existing `manifest_json` is byte-unchanged), parser-validated (camelCase + `auto_fire`),
round-trip tested; mirrors the `localized`/`reservesTools` precedent. (2) **Threshold (D2):**
`AUTOFIRE_SCORE_THRESHOLD = 3` in [`selector.ts`](apps/desktop/src/main/services/skills/selector.ts)
(distinct from `SUGGEST_SCORE_THRESHOLD = 2` — suggestion UNCHANGED) + `selectAutoFire` sharing a
`selectByThreshold` helper with `selectSuggestion` (differ only in the gate). Score ≥ 3 structurally =
"keyword + ≥1 doc signal". (3) **Decision path:** new [`autofire.ts`](apps/desktop/src/main/services/skills/autofire.ts)
`resolveAutoFireSkill(db, deps, conversationId, question)` — candidates = enabled + available +
**app-only** (`source==='app'`, D4) + **`triggers.autoFire===true`** (D6) + **compatible**
(`skillNeedsNewerApp`, §6.5/M1), scored via the existing `scoreSkillTriggers`, gated at the new
threshold, deterministic installId tie-break. Shares the **factored-out**
[`scope-signals.ts`](apps/desktop/src/main/services/skills/scope-signals.ts) `inScopeDocSignals` with
`suggest.ts` (no duplication). LOGS NOTHING (question is content — §6). (4) **Opt-in (D4):** persisted
`skillsAutoFireEnabled` boolean in `AppSettings`/`DEFAULT_SETTINGS` (default **false**); the resolver
reads it first and no-ops when off. (5) **Plumbing (D5/§22-A1):** `resolveTurnSkill`(+`FromRegistry`)
gains an optional `question` and calls auto-fire **only** in the would-return-null branch AND only when
`requestedInstallId === undefined` (so a sticky default, a per-turn pick, and an explicit per-turn
clear `null`/`''` are all respected); both chat channels (`registerChatIpc`/`registerRagIpc`) pass the
turn text so a documents conversation auto-fires too. (6) **Harness is now the GATE:**
[`skill-triggers.test.ts`](apps/desktop/tests/eval/skill-triggers.test.ts) asserts the `threshold-3`
policy (sharing `AUTOFIRE_SCORE_THRESHOLD`) clears D1 as **`fired-wrong == 0` AND `precision ≥ 0.95`**
(owner-set form, survives corpus growth) ALONGSIDE the kept baseline printout. (7) **Privacy guard
extended:** the S12 sentinel test drives a sentinel-bearing question through `resolveAutoFireSkill` —
reaches no console stream, never the resolved skill object. **New contracts:** `AUTOFIRE_SCORE_THRESHOLD = 3`;
`resolveAutoFireSkill`; setting key `skillsAutoFireEnabled` (default false); the harness-as-gate
(fired-wrong==0 ∧ precision≥0.95). `docs/skills-s13-plan.md` §4 folded to "implemented" but STAYS OPEN
(deleted only when S13c closes). Full suite green (**1747 passed / 25 skipped**, +21), typecheck + build
clean. **NEXT ACTION: S13c (surprise-mitigation UX)** — the Settings → Skills opt-in TOGGLE (flips
`skillsAutoFireEnabled`, off by default) + the per-turn "Answered with <skill> — answer without it"
UNDO affordance (re-runs the turn skill-free, the regenerate precedent), EN/DE copy. The glyph already
stamps an auto-fired turn (visible). Until S13c ships the toggle, auto-fire cannot be enabled by a
user, so S13b is inert._

_(prior) 2026-06-17 — **Skills Phase S13a SHIPPED — auto-fire EVALUATION HARNESS + corpus +
baseline (NO runtime behaviour change).** S13 (auto-fire triggers) is gated: auto-fire ships only after
an offline harness proves a precision bar on a labelled corpus. S13a is that harness + the baseline —
pure measurement, no behaviour change; S13b (auto-fire mechanics) and S13c (UX) stay GATED and unstarted
until the owner ratifies D1–D6 from these numbers. **Shipped:** (1) a **synthetic, no-user-data** corpus
of **33 labelled turns** ([`apps/desktop/tests/fixtures/skill-triggers/corpus.json`](apps/desktop/tests/fixtures/skill-triggers/corpus.json))
— de-AT + EN true positives, lone-doc-signal true negatives, filename-near-miss + generic-substring
adversarials; label space = the four real enabled app skills. (2) a deterministic vitest harness
([`apps/desktop/tests/eval/skill-triggers.ts`](apps/desktop/tests/eval/skill-triggers.ts) +
`skill-triggers.test.ts`) that scores the corpus through the **real** `scoreSkillTriggers`/
`selectSuggestion` (no model/network/DB — DS4) and reports precision/recall + the four-cell confusion
matrix, sweeping a few higher thresholds (the D2 proposal). A faithfulness guard pins `threshold-2` ≡
`selectSuggestion`; a privacy guard pins that no corpus question reaches any console stream (extends the
S12 sentinel posture — the question is content, §6). Runs as a MEASUREMENT, not yet a gate-assertion
(the bar lands in S13b). **Baseline** (recorded in `docs/skills-s13-plan.md` §3.3.1): threshold-2 (today)
**60.7%** precision / 100% recall (11 false fires); keyword-required (D2) **81.0%** / 100% (4 residual
substring false fires — the deterministic-keyword precision ceiling); **threshold-3** (keyword + ≥1 doc
signal) **100%** / 88.2% (only 2 keyword-only misses, and a miss is cheap); threshold-4 100% / 70.6%
(too strict). **Reading:** today's threshold is far below an auto-fire bar; a keyword gate alone can't
close the substring false fires; threshold-3 is the natural D2 setting for a ≥95% D1 bar. **D1–D6 RATIFIED by the owner 2026-06-17**
(recorded in `docs/skills-s13-plan.md` §2.1): D1 ≥95% precision; **D2 = `threshold-3` — fire only on a
keyword hit corroborated by ≥1 doc signal** (the literal "require a keyword" was refined up, since it
scores only 81%); D3/D4/D5/D6 as proposed (silent-apply + glyph + undo; opt-in, app-only; fire only when
no skill is set; additive `triggers.autoFire?: boolean`). S13b's hard gate-assertion form is owner-set:
**fired-wrong == 0 AND precision ≥ 0.95** (not a brittle `==100%`), and the corpus should grow with
real-world phrasings. **NEXT ACTION: S13b (auto-fire mechanics)** — `AUTOFIRE_SCORE_THRESHOLD = 3`, the
`triggers.autoFire` schema, `resolveAutoFireSkill` plugged into `resolveTurnSkill`/both chat channels
(app-only + opt-in + only-when-no-skill-set), and flip the harness to the hard gate. Was deferred out of
this session by directive; ready to start. `docs/skills-s13-plan.md` stays OPEN (deleted only when S13
fully closes). Full suite green
(**1726 passed / 25 skipped**), typecheck + build clean._

_(prior) 2026-06-17 — **Skills — active-skill turn-latency: measured root cause + prefix-cache fix
(no new phase).** Report: "chat with a skill active feels slower than with no skill." **Measured before
theorizing** (temporary content-free perf harness over the real bundled SKILL.md files + synthetic
bodies, deleted after measuring — §22-M1). Findings: main side is **< 1 ms/turn** for a bundled skill
(`loadSkillPackage` ≈ 0.65 ms, `buildSkillFence` ≈ 0.06 ms) — NOT the cause. The real driver is the
**measured 288–381-token** body (≈ 447 tokens with framing/guard) injected per skill, paid in **prefill**:
sub-100 ms on GPU but **~3.5–15 s on a laptop CPU** — explains the "noticeably slower" feel and the
CPU/GPU difference. Whether that prefill is one-time (plain chat, fence in the **stable system prefix**)
or per-turn (grounded, fence rides the **varying user turn** by §22-H2 placement) is governed by KV-cache
prefix reuse — which the app was leaving to the llama-server default. **Two low-risk fixes (behind the
unchanged §7 ceiling — offline, audit ids/counts-only, no i18n surface):** **(PERF-1)** the chat request
now sends **`cache_prompt: true` explicitly** ([`runtime/llama.ts`](apps/desktop/src/main/services/runtime/llama.ts)
`chatStream`) so the slot reuses the longest common prefix instead of relying on a release-dependent
default → plain-chat fence is a **one-time** prefill, not per-turn (asserted in `llama-runtime.test.ts`).
**(PERF-2)** the per-turn `loadSkillPackage` ([`skills/loader.ts`](apps/desktop/src/main/services/skills/loader.ts))
is **cached by SKILL.md (mtime,size)** — measured **~33 µs hit vs ~650 µs** uncached (~20×; far more on a
slow portable drive, and it elides the O(paragraphs²) ~19 ms re-size for a 64 KB user skill). DS1/DS2
honoured (an on-disk edit re-parses); reconcile/installer call `parseSkillManifestFromDir` **directly**,
bypassing the cache, so disk→DB stays fresh (new `skills-loader-cache.test.ts`). **Recommended, not done**
(scope/risk, recorded in the design record): grounded fence stays per-turn by placement (keep bodies
small); a large user skill's question-dependent fence trim can shift the plain-chat prefix and defeat
PERF-1 — a fixed user-turn reserve would stabilize it but changes the §22-A6 budget contract (no-op for
every shipped skill). Design record: **architecture.md "Skills — design record" §17**. Full suite green
(**1718 passed**), typecheck + build clean._

_(prior) 2026-06-17 — **Skills — per-locale DISPLAY localization (no new phase).** Skill content
(title/description) was English-only in a German UI (the chrome is i18n'd, but the manifest carried a
single title/description) — visible in the composer picker, the per-message glyph, and Settings →
Skills. Fixed for the **display metadata** (the body stays single-language — the model is multilingual,
D-L6). Design record: **architecture.md "Skills — design record" §16**. **Additive manifest block:**
`SKILL.md` may carry `localized:` (locale → {title?, description?}), parsed in
[`skill-manifest.ts`](apps/desktop/src/shared/skill-manifest.ts) (lenient: malformed/blank/over-long/
multi-line → noted+skipped, never an error; ≤16 locales; keys lower-cased). `SkillManifest.localized` +
`SkillInfo.localized` are optional/additive (manifest_json round-trips it); `recordToInfo` projects it.
**Renderer pick:** a pure helper [`renderer/lib/skillI18n.ts`](apps/desktop/src/renderer/lib/skillI18n.ts)
(`localizedSkillTitle`/`localizedSkillDescription` + `skillTitleResolver` for the glyph), used by
`SkillPicker`, the Settings → Skills cards + detail, and the `Transcript` glyph (installId→title resolver
threaded from `ChatScreen`, built from the full skills list with a stamped-title fallback); every pick
falls back to canonical text. **Bundled skills:** all four (`bank-statement`/`invoice`/`document-redaction`/
`meeting-protocol`) gained a `localized.de` title+description (triggers were already bilingual). Display
only — nothing threads locale into `resolveTurnSkill`/the prompt, so the §7 gate + ceiling are unchanged
and the injected body is byte-identical regardless of UI language. Tests: manifest parser (parse/lenient/
bounds/single-line), the renderer helper (`skill-i18n.test.ts`), and the real bundled manifest's de
override projected through `recordToInfo`. Full suite green (**1713 passed**), typecheck + build clean.
EN/DE app-string parity still compile-enforced._

_(prior) 2026-06-17 — **Skills — LOW / residual follow-ups (no new phase).** The four remaining
LOW/residual items after the §14 audit, all fixed behind the unchanged §7 ceiling (no new capability,
still offline, audit still ids/counts-only, EN/DE parity compile-enforced). Full design record:
**architecture.md "Skills — design record" §15**. **(1) Docs:** [`user-guide.md`](docs/user-guide.md)
gained a §8 "Skills" section (composer picker, per-message glyph, one-tap suggestion, tool skills +
run bar + confirm/cancel, Settings → Skills with import/enable/delete, drop-ins install disabled, the
"Needs newer app" badge) and [`troubleshooting.md`](docs/troubleshooting.md) gained four entries
(drop-in disabled DS19, structural import-rejection reasons, the "Needs newer app" badge, "the skill
tool found nothing"). **(2) `reconcileBalances` honesty:** the lone **baseline** row (first row, or any
row whose predecessor printed no balance) is now `unknown`, not `ok` — `reconciled` needs ≥1 row
genuinely compared against a predecessor (`okCount > 0`), so a single-transaction statement reports
`reconciled: false` / `resultKind: 'unchecked'` instead of "reconciled having verified nothing". The
downstream `resultKind` logic was already keyed off `unknown` (unchanged); the baseline now persists
`reconciled = NULL`. Invoice (`validateInvoiceTotals`) has no baseline concept → no change.
**(3) Cancel ⇄ audit consistency:** when `ctx.signal.aborted`, the gate
([`tool-registry.ts`](apps/desktop/src/main/services/skills/tool-registry.ts)) suppresses the
`skill_run_failed` audit event (a cancelled run audits as started-then-no-terminal), so it agrees with
the `skill_runs` row the seam records as `cancelled`; a genuine non-cancel `!ok` still audits failed.
**(4) minAppVersion gate airtight (the §14/M1 residual):** the use-sites now gate on **compatibility**,
not just `enabled`, reusing `skillNeedsNewerApp`. App version (already threaded via `app.getVersion()`
in §14) carried into `resolveTurnSkill` (`turn.ts` + the registry handle's new `appVersion` field),
`suggestSkillsForTurn` (`suggest.ts`), and `runnableToolNames`/`runnableToolsForSkill` (`tool-runs.ts`,
threaded at both the `listRunnableTools` and `startSkillRun` IPC sites) — so a skill edited on disk to
need a newer app while already enabled is skipped at turn-resolution, never suggested, and refused at
run start. Tests added/extended for each fix (bank-statement unit: single-row/all-baseline/genuine
match+mismatch; tool-registry unit: mid-run-cancel emits no `skill_run_failed`; turn/suggest/tool-run-IPC
integration: enabled-but-incompatible excluded from all three use-sites). Full suite green, typecheck +
build clean._

_(prior) 2026-06-17 — **Skills — content-reach + compatibility audit fixes (no new phase).**
A follow-up audit of the whole skills surface (bugs + docs-vs-code) found one HIGH + three MEDIUMs,
all fixed behind the unchanged §7 ceiling. **H1 (the headline fix):** the Tier-2 content-reading tools
(`extract_transactions`/`extract_invoice`/`redact_document`) had been reading the stored `chunks` table
through `readDocumentChunks` — but those are RETRIEVAL windows (newlines collapsed to spaces, ~80-token
overlap), so the line-oriented extractors got ≈0 rows and the redaction copy was de-formatted/duplicated
on actually-ingested documents (the tests masked it by seeding single chunks with real `\n`). Fix: the IPC
now injects a `readDocumentSegments` capability (the same `extractDocumentPreview` the doc-tasks use —
ordered, non-overlapping, newline-preserving parser segments re-extracted from the stored copy), and the
run seams build the tool reader from it via [`resolveDocumentReader`](apps/desktop/src/main/services/skills/run.ts);
the legacy chunk-table reader stays as the no-injection fallback. Ceiling unchanged — the SEAM holds the
FS/cipher closure, the reach stays frozen to the in-scope id, a failed re-extraction surfaces through the
tool's own "could not be read" path. The tool-run IPC tests now seed a REAL stored `.txt` so they exercise
the production path end-to-end (+ new bank/redaction seam tests prove the injected verbatim reader is
preferred over collapsed chunks). **M1:** the §6.5 `minAppVersion` gate is now ENFORCED (was parsed but
ignored) via a pure [`skillNeedsNewerApp`](apps/desktop/src/shared/skill-manifest.ts) — incompatible app
skills reconcile DISABLED, imports install disabled, the enable IPC refuses (`main.skills.incompatible`),
`SkillInfo` gains `incompatible`/`minAppVersion`, and the Skills tab shows a "Needs newer app" badge with
the toggle off; app version threaded from `app.getVersion()` through registry+installer deps+IPC. **M2:**
`skills.tool.note.active` is now domain-free (it had shown bank-tool copy for the invoice + redaction
skills). **M3:** the terminal-run acknowledge handshake is wired (`skills:clearToolRun` IPC + preload →
`SkillRunController.clear`, previously dead code). Full suite green (**1693 passed**, 25 skipped),
typecheck clean. Design record: **architecture.md "Skills — design record" §14**; drive-layout.md
"instruction stub" line corrected (four bundled skills). EN/DE i18n parity kept (compile-enforced)._

_(prior) 2026-06-17 — **Skills — third Tier-2 bundled app skill: `document-redaction` (content +
tests, no new phase).** A FOURTH app skill ships in `app-skills/`: **`document-redaction`**
(`id: document-redaction`, German "Anonymisierung"), the **third Tier-2 tool skill** and the
**read-transform-export** shape the bank/invoice domains don't exercise. ONE tool in
[`tools/redaction.ts`](apps/desktop/src/main/services/skills/tools/redaction.ts): `redact_document`
(permissions `['read-selected-docs','export-file']` ⇒ confirm-gated) reads the **whole** selected document
(the same `readDocumentChunks` reach over the frozen scope), masks personal data with **deterministic,
offline, regex-only** detectors (email/url/iban/date/phone — each a small pure exported function; dates
validated via the shared `parseDate`, IBANs by structure + per-country length, phones conservative
+country/0-leading shapes), applied in a **fixed order so masks never overlap**
(`email → url → iban → date → phone`) with a fixed category token per match (so redaction is **idempotent**),
and returns `{ redactedText, counts{email,phone,iban,date,url}, totalRedactions }` (JsonSchema-validated).
**Data contract: NO content-class table and NO `BEGIN…COMMIT`** — the deliverable is a FILE: the seam
[`runDocumentRedaction`](apps/desktop/src/main/services/skills/run.ts) records only the `skill_runs`
lifecycle row (started → terminal; `result_ref` stays **NULL**), writes `redactedText` via the existing
confirm-gated MAIN-side `saveTextFile('redacted.txt', …)` boundary, honours the cancelled-before-write
guard (B2) + B4, and surfaces only `totalRedactions` (a count) + a content-free `resultKind`
(`'redacted'`/`'clean'`). **Privacy (the strongest of the three):** the detected values never reach any
log/audit/`skill_runs` row; the redacted text lands ONLY in the user-chosen file. **Honesty:** regex
redaction is **best-effort, not a guarantee** (no ML, no name detection) — SKILL.md body + "done" copy say
review the copy before sharing; `docs/known-limitations.md` records the limit. Wired name `redact_document`
(`tool-registry.ts` REGISTRY + `tool-runs.ts` WIRED_TOOL_NAMES/buildToolRunner — null without
`saveTextFile`). New i18n EN/DE keys (`chat.skill.tool.redactDocument`, `chat.skill.run.done.redacted.*` +
`…redactedClean`); `SkillRunBar` gains the label + the redaction `resultKind` branch (handled like
`validate`). **No IPC / shared-type / controller change.** New tests:
[`skills-redaction-tool.test.ts`](apps/desktop/tests/unit/skills-redaction-tool.test.ts) (each detector
in isolation incl. near-misses + the full pass + idempotence + cancellation + the gate),
[`skills-redaction.test.ts`](apps/desktop/tests/integration/skills-redaction.test.ts) (committed SKILL.md
parse → kind:tool + 1 allowedTool + reservesTools; reconcile-enabled; dispatch descriptor; the read→mask→
write seam incl. clean/dismissed/throwing-save) + extensions to `skills-suggest.test.ts` (German "Bitte
dieses Dokument anonymisieren" clears the threshold), `skills-privacy-guard.test.ts` (a secret email+IBAN
through `redact_document` is **masked out of the saved copy** AND absent from audit/log/console/`skill_runs`),
`skills-tool-run-ipc.test.ts` (the confirm-gated redaction IPC writes `redacted.txt`, count-only state), and
the `skills-tool-registry.test.ts` registered-names list. Full suite green (1690 passed), typecheck + build
clean. Design record: **architecture.md "Skills — design record" §8** (redaction as the read-transform-export
Tier-2 reference, no data table — counts-only run row) + **known-limitations.md** (best-effort caveat)._

_(prior) 2026-06-17 — **Skills — second Tier-2 bundled app skill: `invoice` (content + tests, no
new phase).** A THIRD app skill ships in `app-skills/`: **`invoice`** (`id: invoice`), the **second
Tier-2 tool skill** — it mirrors `bank-statement` layer-for-layer to prove the gate generalizes to a
second content-class domain, with strong EN+DE coverage. Three tools in
[`tools/invoice.ts`](apps/desktop/src/main/services/skills/tools/invoice.ts): `extract_invoice`
(read-only; reads the selected invoice's chunks → header + line items + totals, deterministic/offline,
**conservative** — labeled-line header/totals, ambiguous data dropped, header fields optional),
`validate_invoice_totals` (read-only; half-cent checks — line items→net, net+tax→gross, tax vs. rate —
each ok/mismatch/unknown + a `reconciled` verdict + `resultKind`), and `export_invoice_csv`
(confirm-gated `export-file`; line-items CSV). The deterministic money/date primitives + the CSV
formula-injection `csvField` are now **shared** by both domains in
[`tools/money.ts`](apps/desktop/src/main/services/skills/tools/money.ts) (bank-statement.ts re-exports
them for compat; `detectCurrency` improved to scan all 3-letter tokens so an invoice number's "INV"
never blocks a later "EUR"). The run seam is the sibling
[`invoice-run.ts`](apps/desktop/src/main/services/skills/invoice-run.ts) (reuses `run.ts`'s
`buildReadDocumentChunks`/`finishRun`): same `skill_runs` lifecycle, atomic persist
(BEGIN…COMMIT/ROLLBACK), B2/B4 guards, latest-invoice-for-document downstream target, structured input
(no new `SkillToolContext` accessor — §14 ceiling unchanged). **Data contract:** two new content-class
tables — `invoices` (id, document_id, run_id, vendor, invoice_number, invoice_date, due_date, currency,
net_total, tax_total, tax_rate, gross_total, totals_reconciled, created_at) + `invoice_line_items` (id,
invoice_id, run_id, row_index, description, quantity, unit_price, line_total, currency, created_at),
indexed by document_id / invoice_id; `skill_runs.result_ref` now points at a `bank_statements.id` **or**
an `invoices.id`. Wired tool names: `extract_invoice` / `validate_invoice_totals` / `export_invoice_csv`
(`tool-registry.ts` REGISTRY + `tool-runs.ts` WIRED_TOOL_NAMES + buildToolRunner). New i18n EN/DE keys
(`chat.skill.tool.extractInvoice|validateInvoiceTotals|exportInvoiceCsv`, the invoice done/validate copy);
`needsExtraction` copy genericized "statement"→"document"/"Dokument". `SkillRunBar` gains the three labels
+ the invoice `resultKind` branch. **No IPC / shared-type / controller change** (the generic infra already
supports an arbitrary wired tool). New tests:
[`skills-invoice-tool.test.ts`](apps/desktop/tests/unit/skills-invoice-tool.test.ts) (parsers + each tool
through the gate + CSV formula-injection),
[`skills-invoice.test.ts`](apps/desktop/tests/integration/skills-invoice.test.ts) (committed SKILL.md
parse → kind:tool + 3 allowedTools + reservesTools; reconcile-enabled; dispatch descriptors; extract →
validate → export seams; needs-extraction guard; cancelled-save calm path) + extensions to
`skills-suggest.test.ts` (German "Prüfe die Beträge auf dieser Rechnung" clears the threshold),
`skills-privacy-guard.test.ts` (a secret through invoice extract→validate→export reaches only the
`invoice_*` tables + the CSV, never audit/log/console/`skill_runs`), and the `skills-tool-registry.test.ts`
registered-names list. Full suite green (1662 passed), typecheck + build clean. Design record:
**architecture.md "Skills — design record" §8/§10 + DS17**, **security-model.md** content-class list._

_(prior) 2026-06-17 — **Skills — second bundled app skill: `meeting-protocol` (content + tests
only, no new phase).** A second app skill now ships in `app-skills/`, chosen to exercise the paths the
bank-statement skill never touches. **`meeting-protocol`** is **Tier-1 instruction-only**
(`kind: instruction`, `allowedTools` empty / `reservesTools` false — it only injects fenced guidance,
no tools), and is the **bilingual-trigger** reference: its `triggers.keywords` carry German + English
terms, with umlaut singular/plural pairs listed separately (`beschluss`/`beschlüsse`,
`aufgabe`/`aufgaben`) because the §6 selector matches case-insensitive **substring**
(`question.includes`), so an umlaut breaks the substring. Pure folder drop-in — discovery is the
wholesale `resolveAppSkillsDir → listSkillFolders` scan, so **no IPC / shared-type / main-process
change**. New tests: [`skills-meeting-protocol.test.ts`](apps/desktop/tests/integration/skills-meeting-protocol.test.ts)
(parse → kind:instruction + `allowedTools===[]` + `reservesTools===false`; English+German trigger
coverage incl. the umlaut pairs; reconcile-enabled; resolveTurnSkill → fence with `SKILL_GUARD_LINE`
last) + a focused case in [`skills-suggest.test.ts`](apps/desktop/tests/integration/skills-suggest.test.ts)
(a German "Erstelle bitte ein Protokoll dieser Besprechung" clears `SUGGEST_SCORE_THRESHOLD` and is the
returned offer against the **real** selector; a neutral question returns none). Nothing pins the
app-skill set (the bank-statement test asserts `toContain`, not equality; commercial-drive tests use
synthetic temp fixtures). Design record: **architecture.md "Skills — design record" §1 / DS17**. Full
suite green (one unrelated **flaky** `logging.test.ts` rekey timing assertion passes in isolation),
typecheck + build clean._

_(prior) 2026-06-17 — **Skills — frontend IA + modal follow-ups (manual-test fixes, no new phase).**
Two issues found while eyeballing the running Skills surface, both fixed. **(1) Skills is now a top-level
rail destination, not a Settings tab.** `ScreenId` gains `'skills'`; `SettingsTab` drops it; a thin
[`SkillsScreen`](apps/desktop/src/renderer/screens/SkillsScreen.tsx) wraps the unchanged `SkillsTab`
body in `.screen` chrome (h1 = `skills.title`). `App.tsx` `NAV_TOP` adds `{ id:'skills', icon:'puzzle' }`
(new Lucide puzzle glyph in `Icon.tsx`) → rail is now Home · Chat · Documents · AI Model · **Skills** ‖
Settings. `resolveNavTarget('skills')` → the screen; the legacy `settings:skills` alias still resolves
(now to `{ screen:'skills' }`). New i18n `nav.skills` + `skills.title` (EN/DE); the unused
`settings.tab.skills` key removed. design-guidelines §2 updated (5 primary + 1 utility). **(2) The content
`Modal` now scrolls.** `Modal` wrapped its `{children}` directly in `.dialog`, so a tall body — e.g. a
skill's expanded "Technical details" — overflowed the dialog's `max-height` with no scrollbar (broken
layout). Children now sit in the existing `.modal-body` scroll region (flex:1 + min-height:0 + overflow-y),
matching `ConfirmDialog`. Tests updated (`InformationArchitecture`, `rail-labels`); full suite **1625
passed / 25 skipped**, typecheck + build clean._

_(prior) 2026-06-17 — **Skills — post-S12 audit follow-ups SHIPPED (no new phase; the wave stays
closed).** A second multi-persona audit of the whole skills surface (bugs + docs-vs-code) found **no
CRITICAL/HIGH**; the fixes landed behind the unchanged §14 ceiling (no new capability, still offline,
audit still ids/counts-only). Full design record: **architecture.md "Skills — design record" §13**.
**Bugs:** **B1/B2** — the run controller no longer re-derives a run's outcome from `signal.aborted`; the
seam is the authority (a dismissed CSV save dialog is a **cancel**, not a failure; a success that
out-races a late Cancel is reported `done` — never "cancelled, nothing changed"; `runCsvExport`
re-checks abort before the FS-write so nothing is written under a cancel). **B3** — `summarize_cashflow`
`net` is derived from the rounded totals (self-consistent). **B4** — `runBankExtraction` /
`prepareStatementRun` guard everything after the `skill_runs` 'started' insert, so an unexpected throw
drives a terminal `failed` (never a stranded `started` row). **CSV leading-whitespace** formula
injection (`"  =cmd"`) is now neutralized. **Reconcile one-active-per-id** (DS12) safety net: a DB
rebuild / late app skill that leaves two same-id rows enabled is collapsed to one (trust→version→
recency). **i18n:** **I1/I2** — run-failure copy and
import-preview errors now carry content-free reason **codes** (`SkillRunState.errorCode` /
`SkillPreview.errorCodes`) the renderer maps to EN/DE, so a German user never sees an English
failure/import string; the seam/controller stay i18n-free; EN/DE parity is compile-enforced
(`de: Record<keyof typeof en, string>` — the audit's "parity is convention-only" finding was wrong).
**Security:** **S1** — clamp/`manifest.json`-conflict **notes** no longer echo the raw frontmatter value
(closes the one §22-M1 gap where attacker text rode the `SkillPreview` IPC payload into the UI); **S2** —
`filenamePatterns` ReDoS bounded (parser caps length ≤200 / count ≤64; the glob is matched by the
linear, non-backtracking `selector.globMatches` — vuln-scan 2026-06-21 replaced the original
`globToRegExp` + >10-wildcard cap). **Docs:** **D1** removed the non-existent `skill_selected` audit event from §11; a new
**§-anchor legend** in the design record makes the ~130 historical `skills plan §N` citations + the kept
docs' `§9.5/§13/§14/§22-*` references resolvable (the fold had only retargeted the filename-style cites);
the stale S1 plan snapshot below is marked **superseded** (revoked DS11 + never-built DS13). New/updated
tests in `skill-manifest`, `skills-selector`, `skills-run`, `skills-installer`, `skills-tool-run-ipc`,
`skills-run-controller`, `SkillRunBar`; full suite **green**, typecheck clean. **No open SL-#.**_

_(prior) 2026-06-17 — **Skills Phase S12 SHIPPED — security audit pass + plans folded into the
§-records. The ENTIRE Skills wave (S2→S12) is now CLOSED.** The repo's multi-persona audit ran end to
end over the whole skills surface against the untrusted-skill-as-input threat principle (§14): import
(zip-slip / symlink / zip-bomb / nested-archive / magic-byte), prompt-injection containment (fenced data
turn + the guard line winning + base/grounding always winning), the Tier-2 gate (frozen `documentIds`, no
`Db`/SQL/FS/net handle, input+output validation, confirm-gating, the CSV FS-write boundary), content-class
isolation (`bank_*` + `skill_runs` never logged/audited/exported), ids/counts-only audit, and
`requireUnlocked` on every DB-backed channel. **No CRITICAL/HIGH.** ONE LOW fixed: spreadsheet
**formula-injection** in `export_transactions_csv` — `transactionsToCsv` now prefixes a leading
`= + - @`/tab/CR free-text field with `'` so a crafted statement can't execute on CSV open (numeric
columns untouched; unit-tested). The scattered S10/S11 sentinel tests were **consolidated** into a new
[`tests/integration/skills-privacy-guard.test.ts`](apps/desktop/tests/integration/skills-privacy-guard.test.ts):
one secret driven through every sink (import error, loader, all five tool runs, the CSV export, the IPC
`SkillRunState`) **plus a console spy**, proving absence in audit/log/console/run-metadata while confirming
the deliberate exceptions (content-class tables + the user-chosen CSV); a prompt-injection containment test
proves the guard line stays structurally last even with a hostile body forging the fence delimiter. Two LOW
residuals accepted + documented in `known-limitations.md` (prompt text-injection contained by the structural
ceiling not delimiter-escaping; a user skill's `filenamePattern` is a bounded RegExp run only on a user
action). **Fold (doc-lifecycle rule):** a NEW **"Skills — design record (Phases S2–S12, §1–§12)"** in
`architecture.md` consolidates `skills-plan.md` §1–§19 + `skills-s11-plan.md` (Storage narrative trimmed to a
pointer); the security bits extend `security-model.md` ("Skill tool ceiling" + the S12 audit note + the
CSV-injection note); the 14 in-code/test plan-FILE citations now cite "Skills — design record §N"; **BOTH
plan files deleted** (`git rm`; originals in git history). 8 new tests; full suite **1614 passed / 25
skipped**, typecheck + build clean. **No open SL-#.** **Carry-forward (RESIDUAL, forwarded one last time):**
the running-model Playwright eyeball of the run surfaces (busy row + the now-production-firing export confirm
modal + the result rows) was NOT captured — it needs a seeded indexed statement + a live run + a stubbed
native save dialog, not reliably author-and-verifiable here; the residual + a concrete recipe live in
[`docs/design-review/skills-s12/README.md`](docs/design-review/skills-s12/README.md), and every visual state
is unit-covered by `SkillRunBar.test.tsx`. See the **"Skills — S12 handoff"** block below. **The Skills wave
is done.**_

_(prior) 2026-06-17 — **Skills Phase S11c SHIPPED — remaining bank tools + data tables +
SKILL.md flip to `kind:'tool'`.** The LAST sub-phase of S11. Adds the four downstream bank tools to
`tools/bank-statement.ts` + the `REGISTRY`: `validate_statement_balances` (reconciles each row's
printed vs computed running balance → a per-row `reconciled` flag; honest 'ok'/'mismatch'/'unknown'
status, never invented), `categorize_transactions` (deterministic rule-based → `category_id`, seeding
the built-in `bank_categories`/`bank_category_rules`), `summarize_cashflow` (read-only inflow/outflow/
net totals), `export_transactions_csv` (confirm-gated `export-file`). **Design (recorded):** the
three downstream tools operate on the ALREADY-EXTRACTED rows, which the seam loads (the LATEST
`bank_statements` for the in-scope doc) and passes as STRUCTURED INPUT — tools stay pure, **no new
`SkillToolContext` accessor** (the §14 ceiling is unchanged). New seam fns in `run.ts`
(`runBalanceValidation`/`runCategorization`/`runCashflowSummary`/`runCsvExport`) persist atomically
(BEGIN…COMMIT/ROLLBACK, no-partial-persist). **The CSV export is the first FS-write from a skill
tool:** the pure tool only *produces* the CSV; the IPC layer's `saveTextFile` writes it MAIN-side to a
user-chosen path (save dialog + `writeFile`), gated on `export-file` + the confirm — **path + content
never logged/audited** (only "saved N rows" surfaces). Additive content-class DDL in `db.ts`
(`bank_categories`/`bank_category_rules`/`bank_corrections` + `bank_transactions.category_id/reconciled/
confidence`; never logged/audited/exported). `tool-runs.ts`: `buildToolRunner` gains a case per tool
(+ an opaque `saveTextFile` dep) and `runnableToolNames` is **retargeted** from the `reservesTools`
gate to `resolveEffectiveTools(allowedTools ∩ registry ∩ grant)` now that the flip makes `allowedTools`
effective. **The flip:** `app-skills/bank-statement/SKILL.md` → `kind:'tool'` (SL-1 path keeps the
declared list) + the §6.6 reconcile body; S5 drawer note → the real tool list (`skills.tool.note.active`)
+ the kind-gated "✓ Use approved local tools" line. Generic infra gained ONE content-free field
(`SkillRunState.resultKind` — validate's 'reconciled'/'unreconciled'/'unchecked' verdict; the bank
meaning lives only in the renderer's copy map). EN+DE („du"). 26 new tests (downstream tool units 13,
run-seam integration incl. the export sentinel/cancel/no-confirm 7, IPC export confirm→save 4, the DDL
+ flip-contract + resolveEffectiveTools retarget + SkillRunBar outcome tests). Full suite **1606
passed / 25 skipped**, typecheck + build clean. Docs: architecture.md + security-model.md (the S11c
tool set + the CSV FS-write boundary), `docs/skills-s11-plan.md` (§2 S11c done; status → CLOSED, ready
to fold at S12). SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright eyeball
of the busy row + the (now production-firing) export confirm modal is still uncaptured (the S6-style
walk needs a seeded indexed statement + a live run). See the **"Skills — S11c handoff"** block below.
Next: **S12** (fold `docs/skills-s11-plan.md` into the §-records per the §18 fold-map, then delete it;
the skills security hardening/audit pass)._

_(prior) 2026-06-17 — **Skills Phase S11b SHIPPED — app-orchestrated run trigger + busy row +
write-confirm modal.** The S11a `run.ts` seam is now startable from a USER action (DS4 — never the
model). New generic, bank-free [`services/skills/run-controller.ts`](apps/desktop/src/main/services/skills/run-controller.ts)
(`SkillRunController`: single active run, polling state, Cancel via `AbortSignal`, one-at-a-time) +
[`services/skills/tool-runs.ts`](apps/desktop/src/main/services/skills/tool-runs.ts) — the ONE place
that maps a tool name → the `run.ts` seam (bank specifics stay out of the generic infra, §13), resolves
the in-scope document(s) MAIN-side from the conversation (§22-C4), and bridges the app `AuditRecorder`
down to the ids/counts-only `SkillToolAudit`. Four GENERIC `skills:*` IPC channels (`listRunnableTools` /
`startSkillRun` / `getSkillRun` / `cancelSkillRun` — NOT bank-named, so S11c slots its tools in with no
renderer/IPC change), all `requireUnlocked`, **logging NOTHING content-bearing** (scope is content;
responses are ids/counts only) + preload. Renderer: [`renderer/lib/skillruns.ts`](apps/desktop/src/renderer/lib/skillruns.ts)
(the doc-task polling-store precedent — no new event channel) + [`renderer/chat/SkillRunBar.tsx`](apps/desktop/src/renderer/chat/SkillRunBar.tsx)
(calm OFFER "Extract transactions" → RUNNING "Running: `<tool>` on `<N>` documents… Cancel" → RESULT
"Extracted N transactions"; the **`ConfirmDialog` write/export path** built now even though the read-only
`extract_transactions` skips it), wired into ChatScreen. The trigger keys off the skill's `reservesTools`
signal (the instruction-kind parser discards declared tool NAMES, S9/SL-1) — it switches to the effective
`allowedTools ∩ registry ∩ grant` set at the S11c flip with no renderer change. EN+DE („du"). The bank
skill **stays `kind: instruction`** (the flip + the other 4 tools + reconcile body are S11c). 17 new tests
(run-controller 6 incl. cancel + the synthetic-write-tool confirm gate, tool-run-ipc 5 incl. the "logs
nothing" sentinel, SkillRunBar 6). Full suite **1580 passed / 25 skipped**, typecheck + build clean.
Docs: architecture.md ("Bank-statement tools + the run seam" → the S11b trigger/UI paragraph),
security-model.md ("Skill tool ceiling" — the run trigger + IPC add no content to the log), this plan §2.
SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright eyeball of the busy row +
confirm modal is deferred (the S6-style walk; needs a seeded doc + a live run). See the **"Skills — S11b
handoff"** block below. Next: S11c (the other 4 tools + flip SKILL.md to `kind:'tool'` + reconcile body)._

_(prior) 2026-06-17 — **Skills Phase S11a SHIPPED — `extract_transactions` + `skill_runs` +
bank data tables behind the gate.** First Tier-2 *feature* slice (the plan doc
[`docs/skills-s11-plan.md`](docs/skills-s11-plan.md) was authored + the scope cut RATIFIED by the owner
first: ship `extract_transactions` only; defer `export_transactions_csv` to S11c; content-read =
page-addressable chunks; runs are purely user-initiated). Adds to `SkillToolContext` the ONLY content
reach a tool gets — `readDocumentChunks(documentId) → {text,page,index}[]`, scope-bounded to the frozen
`documentIds` (out-of-scope id ⇒ `[]`; still no `Db`/SQL/FS/net handle). New
[`tools/bank-statement.ts`](apps/desktop/src/main/services/skills/tools/bank-statement.ts) (deterministic
offline parser — bank specifics OUT of the generic registry, §13) defines `extract_transactions`
(read-only); it's listed in the static `REGISTRY` (gate unchanged). New
[`services/skills/run.ts`](apps/desktop/src/main/services/skills/run.ts) `runBankExtraction` is the
app-orchestrated seam (DS4, never model `tool_calls`): records a `skill_runs` lifecycle row (ids/refs
only) → builds the narrow ctx → runs through `runSkillTool` → on success persists the **content-class**
`bank_statements` + `bank_transactions` atomically (ROLLBACK ⇒ no partial rows). Additive DDL in
`db.ts` (`skill_runs` per §8.2 + the two bank tables); content-class tables never logged/audited + NOT
exported (§9.5). Bank skill **stays `kind: instruction`** (the flip + UI are S11b/S11c). 15 new tests
(bank-statement-tool 9, skills-run 6 incl. the §22-M1 sentinel grep, migration, scope, cancel, export
exclusion); the S10 registry test updated for the new tool + ctx key. Full suite **1563 passed / 25
skipped**, typecheck + build clean. Docs: architecture.md (bank tools + run seam), security-model.md
("Skill tool ceiling" S11a), `docs/skills-s11-plan.md` (the open working paper). SL log clean (no new
`SL-#`). See the **"Skills — S11a handoff"** block below. Next: S11b (the user-action run trigger + the
inline "Running: <tool>…" busy row + the write-confirm modal in the transcript)._

_(prior) 2026-06-17 — **Skills — S6 composer-picker live eyeball CAPTURED (carry-forward
closed).** The one open carry-forward from the Skills wave (every UI phase since S6 forwarded the
chat-composer `SkillPicker` "live eyeball" as uncaptured, because the walk harness never brought up
a running model) is now done. New committed walk
[`scripts/walk-skills-composer.mjs`](apps/desktop/scripts/walk-skills-composer.mjs) starts a chat
runtime with no weights present → the factory falls back to the **mock runtime** (clearing ChatScreen
gate A), and the bundled `app-skills/bank-statement/` skill is installed-enabled in dev (gate B), so
the composer + picker finally render for the camera. Captures **5 surfaces × light/dark × EN/DE = 20
PNGs** into [`docs/design-review/skills-s6/`](docs/design-review/skills-s6/): closed picker
("Skill: No skill"), open picker (None + the enabled skill + its description hint), the S8
"Suggested: …" one-tap offer pinned on top, the active state after picking, and the per-message
`.msg-skill` glyph on a mock-runtime answer. **No source behaviour changed** — the walk surfaced NO
rendering/wiring defect (SL log stays clean); Playwright stays an ad-hoc dev tool (NOT in
package.json). Suite still **1548 passed / 25 skipped**, typecheck + build clean. See the **"Skills —
S6 eyeball capture"** block below. No open carry-forward._

_(prior) 2026-06-17 — **Skills Phase S10 SHIPPED — Tier-2 tool-registry design + the
validate→run→validate gate.** New file
[`services/skills/tool-registry.ts`](apps/desktop/src/main/services/skills/tool-registry.ts): the
static app-owned `SkillTool` map (a skill can never register a tool), the effective-set intersection
`resolveEffectiveTools(declared, userGrant)` = `declared ∩ registry ∩ userGrant`, a dependency-free
JSON-Schema-subset validator (`validateJsonSchema` — CLAUDE.md §0, no validator dep), and
`runSkillTool` — the **app-orchestrated** gate (DS4/§2, NOT model `tool_calls`): abort-check →
validate input (refuse before run) → confirm-gate for write/export tools → run inside a **narrow,
frozen-scope `SkillToolContext`** → validate output (wrong shape fails the run) → ids/counts-only
audit. Ships **one harmless reference tool** (`count_selected_documents`, read-only over the frozen
`documentIds`) to prove the gate; **NO bank tools, NO `skill_runs` table, NO data tables** (all S11).
Additive types in `shared/types.ts` (`JsonSchema`, `ToolPermission`, `ToolResult`, `SkillToolAudit`,
`SkillToolContext`, `SkillTool`) + three `skill_run_*` audit events (+ DiagnosticsTab labels + EN/DE
catalogs). 16 new tests (`tests/unit/skills-tool-registry.test.ts`, incl. the §22-M1 sentinel grep).
Full suite **1548 passed / 25 skipped**, typecheck + build clean. Docs: architecture.md (tool registry
+ gate) + security-model.md ("Skill tool ceiling (Tier-2)"). SL log clean. See the **"Skills — S10
handoff"** block below. Next: Phase S11 (bank-statement tools + `skill_runs` + data tables — likely
its own follow-up plan doc)._

_(prior) 2026-06-17 — **Skills Phase S9 SHIPPED — built-in bank-statement instruction stub.**
The FIRST real app skill: committed [`app-skills/bank-statement/`](app-skills/bank-statement/)
(`SKILL.md` + `schemas/transaction.schema.json` + `examples/reading-a-statement.md`, text-only product
content — DS17). The body is **guidance-honest (§22-D1):** quote the statement's own printed figures,
decline to derive unstated ones, flag what can't be confirmed — it makes **no** extraction/reconcile
promise (the §6.6 reconcile body returns with the Tier-2 tools at S11). `kind: instruction`; it
**reserves** its five Tier-2 tools via `allowedTools` (declared intent). **SL-1 (resolved):** the S2
parser empties `allowedTools` for instruction skills (a frozen contract test), so the "tool-reserved"
signal can't ride `allowedTools` — added an **additive `SkillManifest.reservesTools`** (parser sets it
from the *declared* list for any kind; `allowedTools` still `[]` for instruction) + additive
`SkillInfo.reservesTools`; the S5 detail drawer's Tier-2 note now triggers on `reservesTools || kind
=== 'tool'` (was `kind === 'tool'`), so the instruction stub shows "tools arrive with Tier-2" while its
permission block stays kind-gated (no false "can use tools"). `prepare-drive.{ps1,sh}` now **copy
`app-skills/` wholesale** (like `model-manifests/`; `planPrepareDrive.appSkillsToCopy` is the dry-run
reference via `drive.ts listSkillFolders`); `assertCommercialDrive` + `build-commercial-drive.{ps1,sh}`
now **assert ≥1 app skill present + `user-skills/` empty** (`checks.appSkillsPresent`/`userSkillsEmpty`).
14 new tests (skills-bank-statement 8 + commercial 3 + manifest 2 + drive 1; SkillsTab note retargeted).
Full suite **1532 passed / 25 skipped**, typecheck + build clean. Docs: drive-layout.md, packaging.md,
security-model.md, known-limitations.md (the THREE ratified residuals). See the **"Skills — S9
handoff"** block below. Next: Phase S10 (Tier-2 tool-registry design — no heavy tools)._

_(prior) 2026-06-17 — **Skills Phase S8 SHIPPED — skill selector heuristics.** New files:
[`services/skills/selector.ts`](apps/desktop/src/main/services/skills/selector.ts) (pure deterministic
`triggers` scoring — keyword/MIME/filename, fixed threshold, tie-break by installId) and
[`services/skills/suggest.ts`](apps/desktop/src/main/services/skills/suggest.ts)
(`suggestSkillsForTurn` — resolves the conversation scope MAIN-side from the conversationId, §22-C4,
scores ENABLED skills, returns ≤1 offer). New IPC `suggestSkills(conversationId, question?)→
SkillSuggestion[]` (requireUnlocked; logs nothing — the question is content) + preload + the new
`SkillSuggestion` shared type. The composer `SkillPicker` pins the offer **on top, in-picker only**
(owner decision 2026-06-17: no canvas chip), **inert until tapped** (never auto-applies — auto-fire is
the deferred S13 wave). 14 new tests (selector 8, suggest 5, picker 3 added to SkillChat). Full suite
**1518 passed / 25 skipped**, typecheck + build clean. Docs: architecture.md (selector paragraph). See
the **"Skills — S8 handoff"** block below. Next: Phase S9 (built-in Bank-Statement instruction stub +
the three known-limitations.md entries)._

_(prior) 2026-06-17 — **Skills Phases S6+S7 SHIPPED (one unit) — manual activation + prompt
integration.** Skills now actually shape answers. New files:
[`services/skills/prompt.ts`](apps/desktop/src/main/services/skills/prompt.ts) (the fenced data block
+ guard line + the pre-sized token budget — §11) and
[`services/skills/turn.ts`](apps/desktop/src/main/services/skills/turn.ts) (`resolveTurnSkill` — the
ONE resolver shared by both chat channels) +
[`renderer/chat/SkillPicker.tsx`](apps/desktop/src/renderer/chat/SkillPicker.tsx) (composer footer
"Skill: …" picker). `chat.ts` gains the `buildSystemPrompt(skillFence?)` seam, `appendMessage.skillId`,
`getConversationDefaultSkill`/`setConversationDefaultSkill`, and a `listMessages` LEFT JOIN that
resolves a **deleted** skill → NULL (carry-forward invariant, §22-C3); `rag/index.ts` places the fence
in the **grounded user turn** (`buildGroundedPrompt(…, skillFence?)`), never `system` (§22-H2). Both
`registerChatIpc.sendChatMessage` AND `registerRagIpc.askDocuments` resolve+stamp the skill (§22-A1);
new IPC `setConversationDefaultSkill`. The assistant row is stamped **only when the fence was placed**
(§22-A5/A6); the renderer shows a per-message skill glyph (Transcript) + the picker. `Conversation`
gains `activeSkillId`, `Message` gains `skillId`/`skillTitle`, `ChatOptions` gains `skillInstallId`.
~6 EN/DE keys. 27 new tests (skills-prompt 14, skills-turn 9, SkillChat 4). Full suite **1504 passed /
25 skipped**, typecheck + build clean. Docs: architecture.md ("Chat & streaming" skill-selection
paragraph) + rag-design.md (§8 grounded fence note). See the **"Skills — S6+S7 handoff"** block below.
Next: Phase S8 (skill selector heuristics — the in-picker "Suggested: …" offer)._

_(prior) 2026-06-17 — **Skills Phase S5 SHIPPED — Settings → Skills UI.** New file:
[`renderer/screens/settings/SkillsTab.tsx`](apps/desktop/src/renderer/screens/settings/SkillsTab.tsx)
(the installed-skills list with compact rows · `App`/`Made by you` trust chip · enable Switch ·
duplicate-id / files-missing / `Review` chips · "⋯" overflow Export + Delete (Delete hidden for
`source === 'app'`); a toolbar **Import skill…** dropdown → `pickSkillPackage(file|folder)` →
`previewSkillPackage` → a ConfirmDialog showing the calm ✓/✕ permission block + collision/upgrade/
downgrade banners (confirm BLOCKED when `downgradeBlocked` or `!ok`) → `importSkill`; a detail
drawer (Modal) with metadata + the permission block + a tool-skill "guidance only" note (§13/D1) +
a closed-by-default "Technical details" raw-structural disclosure; the DS7 review banner →
`acknowledgeSkillWarning`; empty state). NO new IPC/shared types/main code — pure consumer of the
S4 surface. Registered in `SettingsScreen` (tab order General · **Skills** · Privacy · Diagnostics),
`'skills'` added to `SettingsTab` + nav alias `settings:skills`. **[superseded — see the top
entry: Skills graduated to a top-level rail destination; it is no longer a Settings tab.]** ~70 EN/DE catalog keys (informal
„du"); skill-row + permission-block CSS. 11 new renderer tests
([`tests/renderer/SkillsTab.test.tsx`](apps/desktop/tests/renderer/SkillsTab.test.tsx)). Full suite
**1482 passed / 25 skipped**, typecheck + build clean, Playwright eyeball walk green (list/drawer/
empty in EN+DE × light/dark — `docs/design-review/skills-s5/`, untracked). No docs touched (no new
broadly-reusable UI pattern — §18.0-E). See the **"Skills — S5 handoff"** block below. Next: Phases
S6+S7 (manual activation + prompt integration, shipped together)._

_(prior) 2026-06-17 — **Skills Phase S4 SHIPPED — import/export/install/delete lifecycle + IPC.**
New files: [`services/skills/installer.ts`](apps/desktop/src/main/services/skills/installer.ts) (the
lifecycle core + a NET-NEW dependency-free safe zip extractor — built-in `node:zlib` + a hand-rolled
central-directory parser, NOT JSZip/tar; §22-A2) and
[`ipc/registerSkillsIpc.ts`](apps/desktop/src/main/ipc/registerSkillsIpc.ts) (10 channels:
list/get/pick/preview/import/export/delete/enable/disable/acknowledgeWarning). Import VALIDATES
(traversal/symlink/zip-bomb-on-inflated-bytes/nested-archive-magic/extension-allowlist/§6.4 caps) →
places PLAIN files at `user-skills/<id>/` → reconciles to enabled-with-warning (DS7); coexist-disabled
when an enabled app skill shares the id (trust-first, DS12); downgrade dev-mode-gated (DS15); delete is
a one-txn ref-clear sweep + rm folder (no FK, §22-C3); export writes the package tree only (§9.5). New
shared types `SkillInfo`/`SkillPreview` + `summarizeSkillPermissions` (shared, structural) + audit
events `skill_imported/deleted/enabled/disabled` (ids/counts only). `createSkillRegistry` now
reconciles disk→DB once-per-session on first read (the ratified post-unlock lazy reconcile). Every
reject is a fixed STRUCTURAL string (never echoes attacker content — §22-M1). 24 new tests
(`tests/integration/skills-installer.test.ts` extractor matrix + lifecycle; `skills-ipc.test.ts`
round-trip + sentinel-grep). Full suite **1471 passed / 25 skipped**, typecheck + build clean. Docs:
security-model.md ("Skill-import defences") + architecture.md (lifecycle + IPC table). No Settings UI /
prompt path / activation yet (S5+). See the **"Skills — S4 handoff"** block below. Next: Phase S5
(Settings → Skills UI)._

_(prior) 2026-06-17 — **Skills Phase S3 SHIPPED — registry & persistence (plaintext plain-folder
model).** New files: [`services/skills/registry.ts`](apps/desktop/src/main/services/skills/registry.ts)
(uniform disk discovery + reconcile of `app-skills/` + `user-skills/`, `mark-unavailable`, drop-in →
DISABLED, enable/disable, the `createSkillRegistry` handle) and
[`services/skills/loader.ts`](apps/desktop/src/main/services/skills/loader.ts) (ONE mode — read the
folder — for both sources). Schema: additive `skills` table + nullable `conversations.active_skill_id`
+ `messages.skill_id` (no FK into `skills`). [`services/drive.ts`](apps/desktop/src/main/services/drive.ts)
gains `app-skills`+`user-skills` in `DRIVE_LAYOUT_DIRS` (+ both prepare-drive scripts, parity) and
`resolveAppSkillsDir`/`resolveUserSkillsDir`; `AppContext.skills` wired in `main/index.ts` (best-effort
startup reconcile). 17 new integration tests (`tests/integration/skills-registry.test.ts`); full suite
**1447 passed / 25 skipped**, typecheck + build clean. No IPC/UI/prompt path (S4+). See the **"Skills —
S3 handoff"** block below. Next: Phase S4 (import/export/install/delete lifecycle + IPC)._

_(prior) 2026-06-17 — **Skills Phase S2 SHIPPED — skill package schema & parser (pure, Electron-free).**
New files: [`shared/skill-manifest.ts`](apps/desktop/src/shared/skill-manifest.ts) (the frozen type
contract + `parseSkillMarkdown`/`validateSkillManifest`), plus main-side wrappers
[`services/skills/manifest.ts`](apps/desktop/src/main/services/skills/manifest.ts) (single I/O point
that reads SKILL.md + optional manifest.json and runs the shared validator — §8.1) and
[`services/skills/limits.ts`](apps/desktop/src/main/services/skills/limits.ts) (env-overridable §6.4
caps). 55 new unit tests; suite was **1430 passed / 25 skipped** at S2. See the **"Skills — S2 handoff"**
block below for the four-field handoff._

_**Skills — OWNER DECISION REVISION (2026-06-17), folded into [`docs/skills-plan.md`](docs/skills-plan.md)
§0 (authoritative).** Skills are now stored **UNENCRYPTED as plain folders** — `<root>/app-skills/`
(read-only) + `<root>/user-skills/` (read-write, power-user droppable), both outside `workspace/` —
because a skill package is **non-secret task knowledge, not user content** (DS20). This **revokes
DS11** (no encrypted blob / decrypt-transient / shred), **rewrites DS3/DS1** (disk-is-truth uniform
reconcile for both sources), and **adds DS19** (a folder dropped into `user-skills/` is discovered but
installs **DISABLED** until the user enables it; a deliberate zip-import via the view keeps DS7
enabled-with-warning) and **DS20** (confidentiality boundary: secret material goes in an encrypted
document, never a skill; `user-skills/` must be included in the workspace backup). **Dropped from the
plan:** §22-**C1** orphan recovery (disk is truth), §22-**A3** crash-sweep extension (no encryption
transients), and §22-**C2** downgraded from invariant to cache convenience. **§22-M2 (app-skill
integrity) RESOLVED as accept + document** the drive-provisioning residual (a hash manifest on a
writable drive is unanchored; real integrity = off-drive signing, a Tier-3 prerequisite — same
residual already accepted for the engine binary). **Still mandatory:** the NEW safe member-by-member
zip extractor (§22-A2) + `services/skills/limits.ts` — a view-imported `.skill.zip` is still
attacker-supplied and is now unzipped straight to a real on-disk folder. **Impact on the shipped S2
commit: none** — `shared/skill-manifest.ts` is storage-agnostic and `parseSkillManifestFromDir` is now
the single read path for both sources. S3 spec, S4 spec, §7/§8/§9/§14/§17/§19/§20 + the §18 matrices
updated accordingly._

### Skills — S12 handoff (2026-06-17) — THE WAVE IS CLOSED

**What this phase did** (the closing phase: the security audit ritual + the doc fold — primarily
hardening + documentation, no new feature):

**(A) Multi-persona security audit of the whole skills surface.** Personas: import/extractor security,
prompt-injection containment, the Tier-2 gate + data-flow privacy, audit/log privacy. **No CRITICAL,
no HIGH.** The shipped gate was NOT redesigned — the audit added tests + one small hardening fix.
- **Fixed (LOW) — CSV spreadsheet formula-injection (F4).** `transactionsToCsv` (`tools/bank-statement.ts`)
  now neutralizes a free-text field whose first char is a formula trigger (`= + - @`, tab, CR) by
  prefixing `'`, so a crafted statement description can't execute when the exported CSV is opened in
  Excel/Sheets/LibreOffice. Numeric columns (amount/balance) are formatted separately and untouched.
  This is the one real FS-write boundary, so it earns the hardening. + a unit test.
- **Consolidated sentinel guard (NEW `tests/integration/skills-privacy-guard.test.ts`, 7 tests).** One
  secret driven through EVERY sink — import error payload, loader, all five tool runs, the CSV export,
  the IPC `SkillRunState` — **plus a console spy** (the gap the per-layer S10/S11 sentinels lacked),
  proving absence in audit/log/console/run-metadata while confirming the deliberate exceptions land
  (the content-class `bank_transactions` + the user-chosen CSV — correct). Plus a **prompt-injection
  containment** pair: a hostile body that forges the `--- END LOCAL SKILL ---` delimiter and shouts
  "ignore previous instructions" cannot displace the guard line (it is structurally last) — and per
  §14 the structural ceiling means a text-level injection can't act anyway.
- **Accepted LOW residuals (documented in `known-limitations.md`):** (1) prompt text-injection is
  contained by the **structural ceiling**, not by escaping the fence delimiter (we deliberately don't
  sanitize the body); (2) a user skill's `triggers.filenamePattern` compiles to a bounded RegExp, run
  only on a user action (no auto-fire). Verified the existing S9 residuals (DS20 confidentiality, the
  §22-M2 app-skill integrity-by-location, the DB-rebuild-resets-enable) — present, not duplicated.

**(B) Folded the two plans into the §-records, then deleted them (doc-lifecycle rule).**
- **NEW `architecture.md` "Skills — design record (Phases S2–S12, §1–§12)"** consolidates
  `skills-plan.md` §1–§19 + `skills-s11-plan.md` (§1 Decisions, §2 Hard rules, §3 Storage/registry,
  §4 Import lifecycle, §5 Selection/prompt, §6 Suggestion, §7 Tier-2 gate, §8 Bank tools + run seam,
  §9 Run trigger/UI, §10 Data model, §11 IPC/audit, §12 Trade-offs + the S12 audit). The long Storage
  narrative was **trimmed to a one-paragraph pointer** (condense, not duplicate).
- **`security-model.md`** — the "Skill tool ceiling" record gained the CSV-injection-neutralization
  note + a closing **"S12 — the closing multi-persona audit"** paragraph (no CRITICAL/HIGH, the one
  fix, the consolidated guard, the residuals, the §14 unchanged guarantees held). The "Skill-import
  defences" + "App-skill provisioning…" records were already complete.
- **In-code citations:** the 14 plan-FILE references (`docs/skills-s11-plan.md §…` / `docs/skills-plan.md
  §…`) in `db.ts`, `run.ts`, `tools/bank-statement.ts` + four test headers now cite
  **"Skills — design record §N"** (data model → §10, run seam/tools → §8, controller → §9). The §-anchors
  are stable so future code can keep citing them.
- **Deleted `docs/skills-plan.md` + `docs/skills-s11-plan.md`** (`git rm`; full originals in git history —
  `git show <S12^>:docs/skills-plan.md`).

**Non-negotiable invariants HELD (§14 "unchanged guarantees"):** CSP, the deny-by-default permission
handler, the offline guard, the encryption posture, and packaging were **not touched**. App-orchestrated
only (DS4). Audit stays ids/counts-only. No new native dep, offline. No user data/weights/generated files
committed. The untracked `docs/design-review/skills-s5/` was left out of the commit.

**Tests/build:** 8 new tests (privacy-guard 7 + the CSV-injection unit). Full suite **1614 passed / 25
skipped**, `npm run typecheck` + `npm run build` clean.

**Open landmines:** **none. SL log final — no open `SL-#`** (SL-1 was resolved in S9). **Carry-forward
(RESIDUAL — forwarded one final time, NOT faked):** the running-model Playwright eyeball of the
`SkillRunBar` run surfaces (OFFER → busy row → result rows for extract/validate/categorize/summarize +
the now-production-firing export confirm modal, EN/DE × light/dark) was **not captured**. It needs a
seeded **indexed** statement (so `listRunnableTools` is non-empty) + a live extract→export run + a stubbed
native save dialog — which couldn't be authored-and-verified in this headless/no-Playwright/de-AT dev
environment without risking a broken committed harness, and a fake capture is worse than an honest gap.
Every visual state is unit-covered by `tests/renderer/SkillRunBar.test.tsx`; the residual + a concrete
capture recipe live in `docs/design-review/skills-s12/README.md`. (The composer-picker half was captured
live at S6 — `docs/design-review/skills-s6/`.)

**What's next:** nothing in the Skills wave — it is **CLOSED**. The only deferred skills work is the
post-v1 **S13** (auto-fire triggers, gated on an evaluation harness) and the standing residuals above.

### Skills — S6 eyeball capture (2026-06-17)

**What this closed.** The Skills wave's one open carry-forward: the S6 chat-composer `SkillPicker`
"live eyeball" that every UI phase S6→S10 forwarded as uncaptured. It was never a bug or a missing
feature — the picker's behaviour is covered by `SkillChat.test.tsx`; what was missing was the
mandatory Playwright screenshot-walk artifact (design-guidelines §11.4), because the walk harness had
never brought up a running model, so the composer (gated behind a RUNNING runtime) never rendered.

**How.** New committed walk
[`scripts/walk-skills-composer.mjs`](apps/desktop/scripts/walk-skills-composer.mjs) (mirrors the
`walk-docs-subnav.mjs` shape: gate flow, `shotBoth(theme)`, per-locale loop, seeding via
`window.api`). It clears **both** ChatScreen gates: (A) it calls `window.api.selectModel` +
`startRuntime` on a chat manifest with **no weights on the fresh eyeball root**, so the start gate's
developer-leniency path falls back to the built-in **mock runtime** (`registerModelIpc` →
`services/runtime/mock.ts`), which both renders the composer AND streams a simulated reply; (B) the
bundled `app-skills/bank-statement/` skill is discovered + installed-enabled in dev, so
`enabledSkills.length > 0` for free. Plaintext-dev policy (no unlock gate), offline, window widened
to 1360px so the conversation list (and its "New chat" reset between locales) is visible.

**Captured** — `docs/design-review/skills-s6/`, **5 surfaces × light/dark × EN/DE = 20 PNGs**
(committed alongside the script, per the `skills-s5/` precedent): `composer-<loc>-skill-none` (closed
picker), `picker-<loc>-open` (None + the enabled skill + its description hint), `picker-<loc>-suggest`
(the S8 "Suggested: Bank Statement Analysis — use it?" offer pinned on top, fired by the draft
"reconcile this bank statement" scoring the `triggers`), `composer-<loc>-skill-active` (closed trigger
now showing the picked skill's title), and `message-<loc>-skill-glyph` (the per-message `.msg-skill`
"brain" glyph on a mock-runtime answer).

**Findings.** The walk ran clean and exposed **NO** rendering/wiring defect — **SL log stays clean,
no new `SL-#`.** Surfaces matched the unit-test expectations: the suggestion pins above the radio
group only while unselected; the active footer + the glyph both stamp the skill title (English
author-language) regardless of UI locale. No source behaviour was changed.

**Process / tooling notes.** Playwright is an **ad-hoc dev tool, NOT in `package.json`** (CLAUDE.md
§0 no-new-committed-deps bias) — install with `npm i playwright --no-save -w apps/desktop` (or `-D`
then revert the manifest), run, done; node_modules carries it uncommitted. The walk must `npm run
build` first (it drives the BUILT bundle out/main, which vitest never exercises) and **strip
`ELECTRON_RUN_AS_NODE`** from the child env (the VSCode host exports it). `docs/design-review/` also
holds untracked `skills-s5/` PNGs from the S5 walk — unrelated to this chore, left as-is.

### Skills — S11c handoff (2026-06-17)

**What this phase added** (the last S11 sub-phase — the remaining tools + tables + the flip):
- **`tools/bank-statement.ts`** — four new PURE tools + exported helpers (unit-tested without DB/
  Electron): `validate_statement_balances` (`reconcileBalances` → per-row `ok`/`mismatch`/`unknown`,
  overall verdict = a checkable row exists AND no mismatch), `categorize_transactions`
  (`categorizeRow`/`categorizeRows` over `BUILTIN_CATEGORY_RULES`; sign fallback Spending/
  Uncategorized), `summarize_cashflow` (`summarizeCashflow` — currency only when uniform, honest),
  `export_transactions_csv` (`transactionsToCsv` — RFC-4180 quoting, fixed-dp amounts, blanks for
  nulls). All deterministic/offline, §22-D1 honest. Registered in `tool-registry.ts` `REGISTRY`.
- **`db.ts`** — additive content-class DDL: `bank_categories`, `bank_category_rules`, `bank_corrections`
  (created now, written by a future correction UI — out of S11c scope) + `ensureColumn`
  `bank_transactions.category_id/reconciled/confidence`. Never logged/audited/exported (§9.5).
- **`run.ts`** — `runBalanceValidation` / `runCategorization` / `runCashflowSummary` / `runCsvExport`
  over a shared `prepareStatementRun` prefix (begin run → locate the **latest** statement → load rows
  → run the pure tool through the gate with structured input). Persistence atomic + no-partial-persist;
  `ensureBuiltinCategories` seeds categories + rules once. `runCsvExport` takes an injected
  `saveTextFile` (no FS handle in the seam itself); a cancelled save → run `cancelled`, friendly copy.
- **`tool-runs.ts`** — `buildToolRunner` is now a switch with a case per tool (+ a `ToolRunDeps`
  carrying `saveTextFile`; the export case returns `null` if it's absent). `runnableToolNames`
  retargeted to `resolveEffectiveTools(skill.manifest.allowedTools, skill.manifest.allowedTools)`
  filtered to wired names (grant = declared; no per-tool UI in v1). `WIRED_TOOL_NAMES` lists all five.
- **`registerSkillsIpc.ts`** — a closure `saveTextFile` (focused-window save dialog → `writeFile`,
  logging NOTHING) passed into `buildToolRunner`. The channels/preload are otherwise unchanged.
- **Generic infra** — ONE additive content-free field: `ToolRunOutcome.resultKind` + `SkillRunState
  .resultKind` (an opaque discriminator; the controller copies it on success). The bank meaning lives
  only in the renderer's copy map.
- **Renderer** — `SkillRunBar.tsx` gains `TOOL_LABEL_KEY`/`TOOL_DONE_KEY` entries + a `doneMessage`
  that keys per-tool copy and renders validate from `resultKind`. `SkillsTab.tsx` shows
  `skills.tool.note.active` (the real tool list) for `kind:'tool'` (the "arrive with Tier-2" note now
  only for a reservesTools *instruction* skill); the "✓ Use approved local tools" line is already
  kind-gated in `PermissionBlock`, so the flip lights it up. EN+DE catalogs extended.
- **The flip** — `app-skills/bank-statement/SKILL.md` → `kind:'tool'` + the §6.6 reconcile body
  (honest: app-orchestrated only, never invents a figure, work from the extracted table).

**Decisions taken (record):**
- **Downstream tools take STRUCTURED INPUT, not a new context accessor** (the seam loads the rows). The
  §14 ceiling is unchanged — a tool still has only the frozen `documentIds` + `readDocumentChunks`.
- **A run targets the LATEST `bank_statements` for the in-scope document** (`ORDER BY created_at DESC,
  id DESC`); no statement ⇒ a friendly "read the statement first" failure (no figure invented).
- **CSV write is MAIN-side to a user-chosen path; path + content are never logged/audited.** Only
  "saved N rows" surfaces; a cancelled save persists nothing. Gated on `export-file` + the confirm.
- **`summarize_cashflow` figures are NOT surfaced in v1** (content; the busy row stays ids/counts) —
  the run reports a count; a dedicated view / the model-explains step surfaces the totals later.
- **Permissions:** validate/categorize/summarize are `read-selected-docs` (no per-call prompt) — they
  persist only DERIVED annotations (reconciled flag / category id), the same content-class posture as
  extract; only the FS-writing `export_transactions_csv` is `export-file` (confirm-gated).

**Open landmines:** none. SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright
eyeball (busy row + the now-production-firing export confirm modal, EN/DE × light/dark) is still
uncaptured — the S6-style walk needs a seeded indexed statement + a live extract→export run.

**What S12 consumes:** S11 is CLOSED. Fold `docs/skills-s11-plan.md` into the §-records per its §18
fold-map (tools/registry/run orchestration → architecture.md "Skills — design record"; the tool
ceiling + content-class data + the CSV FS-write boundary → security-model.md), then **delete the plan
file** (the original stays in git history). Then the skills security hardening/audit pass.

### Skills — S11b handoff (2026-06-17)

**What this phase added** (UI/IPC only — NO new tools, tables, or SKILL.md flip):
- **`services/skills/run-controller.ts`** (new, GENERIC — no bank knowledge): `SkillRunController` —
  one active run, `start(runner)` kicks off without awaiting + returns the `running` snapshot,
  `get(handle)` polls a copy, `cancel(handle?)` aborts the `AbortSignal`, `clear(handle)` drops a
  terminal run; merges the tool's `onProgress` into the polled `SkillRunState`. One-at-a-time.
- **`services/skills/tool-runs.ts`** (new, the DISPATCH — allowed to know bank, like the tool file):
  `buildToolRunner(db, toolName, …, audit)` maps `extract_transactions` → `runBankExtraction`;
  `runnableToolsForSkill`/`runnableToolNames` (gated on `reservesTools`); `resolveInScopeDocumentIds`
  (scope resolved MAIN-side from the conversation, §22-C4); `toolRunNeedsConfirmation` (registry-
  driven); `toSkillToolAudit` (bridges the 3-arg `AuditRecorder` → the 2-arg ids/counts-only sink).
- **IPC (`registerSkillsIpc.ts`)**: four generic `skills:*` channels — `listRunnableTools` (offer),
  `startSkillRun` (→ `{started, run} | {needsConfirmation} | {error}`), `getSkillRun`, `cancelSkillRun`
  — all `requireUnlocked`, logging nothing content-bearing. A closure-held controller (no AppContext
  plumbing — at most one run). + preload methods + `main.skills.run.*` EN/DE copy.
- **Renderer**: `lib/skillruns.ts` (module-level polling store, the `doctasks.ts` precedent) +
  `chat/SkillRunBar.tsx` (offer/busy/result + the `ConfirmDialog` write/export path) + ChatScreen
  wiring (`useSyncExternalStore`, `listRunnableTools` effect, `onRunTool`) + `.skill-run-bar` CSS +
  `chat.skill.run.*`/`chat.skill.tool.*`/`chat.skill.confirm.*` EN/DE keys.

**Decisions taken (record):**
- **Channel shape = GENERIC `skills:*`, not bank-named.** Rationale: S11c adds `export_transactions_csv`
  et al. by adding a `buildToolRunner` case + a wired-tool entry — the channel/controller/renderer/
  preload do not change. Bank specifics are confined to `tool-runs.ts` + `run.ts` (§13).
- **The trigger keys off `reservesTools`, not the effective tool set.** The instruction-kind parser
  empties `allowedTools` (S9/SL-1), so the declared tool NAMES are gone for the bank stub; v1 offers the
  wired registry tools to any `reservesTools` skill (in v1 only the bank skill qualifies, and
  `extract_transactions` safely no-ops on a non-statement). At the **S11c flip to `kind:'tool'`**, switch
  `runnableToolNames` to the effective `allowedTools ∩ registry ∩ grant` — renderer unchanged.
- **Confirmation is decided up-front by the renderer from `RunnableTool.requiresConfirmation`** (main-
  computed, authoritative) and **enforced defensively by the gate** (`runSkillTool` confirm-gate +
  the `startSkillRun` `needsConfirmation` guard). For v1 (read-only only) the modal never fires in
  production; the path is proven by a synthetic write tool (controller + renderer tests).
- **No `run.ts`/gate change was needed** — the seam already exposes `signal`/`onProgress`/`audit`.

**Open landmines:** none. SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright
eyeball of the busy row + confirm modal is uncaptured (needs a seeded indexed doc + a live extract run;
the S6-style walk). SkillRunBar.test.tsx covers every visual state; the walk is the only gap.

**What S11c consumes:** add the remaining 4 tools to the `REGISTRY` + `tools/bank-statement.ts`; add a
`buildToolRunner` case per tool (`export_transactions_csv` is confirm-gated `export-file` — the
`SkillRunBar` modal already gates it); add the categories/rules/corrections/reconciliation tables; then
**flip `app-skills/bank-statement/SKILL.md` to `kind:'tool'`** (makes `allowedTools` effective) + swap to
the §6.6 reconcile body + update the S5 drawer note to the real tool list + the "✓ Use approved local
tools" line. When flipped, retarget `runnableToolNames` to `resolveEffectiveTools`.

### Skills — S11a handoff (2026-06-17)

**Phase 0 (ratified before code):** authored [`docs/skills-s11-plan.md`](docs/skills-s11-plan.md) — the
OPEN working-paper plan (folds into the §-records at S12). Owner ratification (AskUserQuestion):
(1) first slice ships **`extract_transactions` only**; (2) **`export_transactions_csv` deferred to
S11c**; (3) content-read = **page-addressable chunks**; (4) runs are **purely user-initiated** in v1.
Sub-phases: **S11a** (tools behind the gate, no UI — this), **S11b** (run trigger + busy row +
write-confirm modal), **S11c** (the other 4 tools + flip SKILL.md to `kind:'tool'` + reconcile body).

**Contracts produced** (what S11b/S11c consume):
- **`shared/types.ts`** — additive: `DocumentChunkRead = {text, page, index}` + a `readDocumentChunks(documentId)
  → DocumentChunkRead[]` method on `SkillToolContext`. It is the WHOLE content reach a tool has:
  scope-bounded to the frozen `documentIds` (out-of-scope id ⇒ `[]`), still **no `Db`/SQL/FS/net handle**.
- **`db.ts`** — additive DDL (`IF NOT EXISTS`, no data migration): `skill_runs` (per §8.2 — ids/refs only:
  `document_ids_json` ids, `status` started|done|failed|cancelled, `result_ref` a `bank_statements.id`,
  `error` friendly/technical) + the **content-class** `bank_statements` + `bank_transactions` (real
  figures — encrypted DB only, never logged/audited, NOT exported §9.5). Categories/rules/corrections are
  additive at S11c (no overbuild, §13).
- **`services/skills/tools/bank-statement.ts`** (new): `extractTransactionsTool` (read-only,
  `read-selected-docs`) + the deterministic/offline parser (`parseDate`/`parseAmount`/`detectCurrency`/
  `extractTransactionRows`, exported for unit tests). Drops ambiguous rows / never invents currency
  (§22-D1 honesty). Bank logic kept OUT of the generic registry (§13).
- **`tool-registry.ts`**: `REGISTRY` now lists `count_selected_documents` + `extract_transactions`; the
  gate itself is **unchanged**.
- **`services/skills/run.ts`** (new): `runBankExtraction(db, {skillInstallId, conversationId?, documentId},
  {audit, signal?, onProgress?, now?}) → {ok, runId, statementId?, transactionCount?, error?}` — the exact
  app-orchestrated seam S11b's IPC/UI will call. Builds the narrow ctx (incl. the `readDocumentChunks`
  closure over a per-doc chunk SELECT), runs through the gate, persists atomically.

**Decisions taken or changed:**
- **The gate audits the TOOL run; the seam owns the `skill_runs` TABLE + bank data.** Two distinct sinks:
  `runSkillTool` brackets the run on the ids/counts-only AUDIT sink; `run.ts` writes the run-history row
  + content tables. Both stay content-free except the bank tables (content-class by design).
- **Currency is required per row; a row with no detectable currency is DROPPED, not invented** (honesty).
  A statement with no ISO code/symbol yields zero rows — acceptable for the deterministic v1 extractor
  (parse quality is a known limitation that improves later, not an ML claim).
- **No-partial-persist via `BEGIN…COMMIT`/ROLLBACK** (the `node-vectors.ts`/`tree-build.ts` precedent):
  the `started` row is committed first; bank rows + the `done` update are one transaction; a write error
  ROLLBACKs and the run is marked `failed` with a friendly error.

**Open landmines:** none. SL log clean (no new `SL-#`). The bank skill stays `kind: instruction` — the
flip to `kind:'tool'` (which makes `allowedTools` effective via the SL-1 parser path) + the reconcile
body + the drawer/permission-line update are an explicit **S11c** sub-phase.

**What S11b consumes:** the `run.ts` seam (wrap it in IPC — `requireUnlocked`, log nothing: the
question/scope is content) + the `skill_runs`/bank tables for a results view; add the inline calm
"Running: <tool> on <N> documents… (Cancel)" busy row (doc-task busy-row precedent) + the write/export
confirm modal (model-download/lock-now precedent), EN/DE. The run is triggered from a USER action (DS4).

### Skills — S10 handoff (2026-06-17)

**Contracts produced** (what S11 consumes):
- **`shared/types.ts`** — additive (the S2 spine is unchanged; these are net-new Tier-2 types):
  - `JsonSchema` — the validated subset (type/properties/required/additionalProperties/items/enum/
    min·maxLength/min·maximum/min·maxItems/pattern). Hand-rolled, no validator dep (CLAUDE.md §0).
  - `ToolPermission = 'read-selected-docs' | 'write-generated-doc' | 'export-file'` — **no
    `read_arbitrary_fs`/`network`/`raw_sql` token exists** (structural ceiling).
  - `ToolResult = {ok:true,output,resultRef?} | {ok:false,error}` (friendly, content-free error).
  - `SkillToolAudit = (type, meta?) => void` — ids/counts-only sink (no free-text message arg).
  - `SkillToolContext = { documentIds: readonly string[]; signal; onProgress?; audit }` — **no
    Db/SQL/FS/net handle**. The gate hands the tool a **frozen** `documentIds` (cannot widen scope).
  - `SkillTool = { name; description; inputSchema; outputSchema?; permissions; run(input, ctx) }`.
  - Three audit events: `skill_run_started` / `skill_run_done` / `skill_run_failed` — metadata
    `{skillId, toolName, documentCount}` ONLY (+ DiagnosticsTab `AUDIT_TYPE_LABELS` + EN/DE catalogs).
- **`services/skills/tool-registry.ts`** (new):
  - `validateJsonSchema(schema, value, path?) → string[]` (structural errors, never echoes input
    values — §22-M1), `validateToolInput` / `validateToolOutput`.
  - `getRegisteredTool(name)` (own-property only), `listRegisteredToolNames()`,
    `resolveEffectiveTools(declared, userGrant)` = `declared ∩ registry ∩ userGrant`
    (unregistered/ungranted dropped, deduped, declared order preserved).
  - `toolRequiresConfirmation(tool)` = true iff a write/export token is present.
  - `runSkillTool(tool, {skillId, input, ctx, confirmed?}) → Promise<ToolResult>` — the gate
    (abort → input-validate → confirm-gate → run-on-frozen-ctx → output-validate → audit).
  - `count_selected_documents` — the ONE shipped reference tool (pure, offline, read-only, needs
    only `read-selected-docs`, no confirm). It is the registry's only entry.

**Decisions taken or changed:**
- **SkillToolContext exposes NO raw `Db` (refines the §12.1 sketch toward the §12.2/§14 intent).**
  The plan's §12.1 type sketch showed `db: Db`, but §12.2 + §14 require a *narrow read API, no
  fs/net/sql handle*. S10 resolves this: the v1-of-Tier-2 context exposes only the frozen id scope
  (+ signal/progress/audit). **S11 adds a NARROW, scope-bounded content-read method** (e.g.
  `readDocumentText(id)` confined to `documentIds`) — still never a raw `Db`/SQL/FS/net handle. This
  also keeps the tool types fully shared-safe (no `main/` import leaks into `shared/types.ts`).
- **Pre-run refusals are NOT audited as runs.** Abort / invalid-input / missing-confirm return
  `{ok:false}` *without* a `skill_run_*` event — the run audit log records actual runs only. An
  actual run is bracketed `started → done|failed`. (The sentinel grep pushes a secret through a
  *successful* run to prove the audit payload stays ids/counts-only.)
- **The validator is a hand-rolled JSON-Schema subset, not a dep.** Honors CLAUDE.md §0 (no new
  native deps / offline). It covers what tool I/O contracts need (incl. the committed
  `transaction.schema.json` shape) and is the same dependency-free posture as `ingestion/limits.ts`.

**Open landmines:** none. SL log stays clean (SL-1 was resolved in S9). Carry-forward: **CLOSED** —
the S6 composer-picker live eyeball was captured in the follow-up chore (see the **"Skills — S6
eyeball capture"** block above this one); no open carry-forward remains.

**What S11 consumes:** the whole `tool-registry.ts` gate + types above. S11 adds the real
bank-statement tools (`extract_transactions` et al.) into the registry, the `skill_runs` table + the
bank-statement data tables, the narrow content-read method on `SkillToolContext`, and the
app-orchestrated chat/UI integration (the inline "Running: <tool>…" busy row + the write-confirm
modal wired into the transcript). The committed `schemas/transaction.schema.json` is the typed I/O
contract those tools validate against; the bank-statement stub's `reservesTools`/`allowedTools`
declaration names the tools the registry will wire (and its SKILL.md body swaps to the §6.6
reconcile/validate body once the tools are effective for a `kind: 'tool'` skill).

### Skills — S9 handoff (2026-06-17)

**Contracts produced** (what S10/S11 + the sell pipeline consume):
- **`app-skills/bank-statement/`** (committed): `SKILL.md` (`kind: instruction`, guidance-honest body,
  `allowedTools` reserving the 5 Tier-2 tools, `triggers`), `schemas/transaction.schema.json` (the
  Tier-2 row contract, present early — S11 reads it), `examples/reading-a-statement.md` (honest worked
  example). InstallId resolves to **`app:bank-statement`** (deterministic natural key, S3).
- **`shared/skill-manifest.ts`**: additive `SkillManifest.reservesTools?: boolean` — the parser sets it
  `true` whenever the frontmatter DECLARES a non-empty tool list, **for any kind**; `allowedTools`
  still stays `[]` for an instruction skill (the frozen S2 contract — it cannot USE tools in v1). This
  is the durable "tool-reserved" display signal that survives reconcile (cached in `manifest_json`).
- **`shared/types.ts`**: additive `SkillInfo.reservesTools?: boolean` (`recordToInfo` sets it from
  `manifest.reservesTools`).
- **`services/drive.ts`**: `listSkillFolders(dir) → string[]` (subdirs containing a `SKILL.md`, sorted)
  — shared by the prepare plan + the commercial gate; `PreparePlan.appSkillsToCopy` +
  `PreparePlanOptions.appSkillsDir` (dry-run reference for the wholesale copy).
- **`services/commercial-drive.ts`**: `assertCommercialDrive` gains `checks.appSkillsPresent` (≥1 app
  skill under `app-skills/`) + `checks.userSkillsEmpty` (`user-skills/` empty) — both always-on; a
  missing app skill OR any `user-skills/` entry flips `ok` to false with a `problems[]` line.
- **Scripts:** `prepare-drive.{ps1,sh}` copy `app-skills/` wholesale; `build-commercial-drive.{ps1,sh}`
  natively cross-check the same app-skills-present + user-skills-empty invariants (parity).

**Decisions taken or changed:**
- **DS17/drawer-note tension resolved — keep `kind: instruction`, trigger the note off
  `reservesTools` (not `kind`).** The stub is instruction-only (§2/§6.6), so it can't be `kind: 'tool'`;
  but the drawer's Tier-2 note must show. Since the parser empties `allowedTools` for instruction
  skills, the signal is the new `reservesTools` flag. The permission-block "✓ Use approved local
  tools" line stays `kind === 'tool'`-gated, so the instruction stub honestly shows NO current tool
  capability while still surfacing "tools arrive with Tier-2".
- **Commercial gate checks are ALWAYS-ON** (not opt-in like the runtime/ocr pins): they need only
  `rootPath`. The 5 existing `ok:true` commercial tests were updated to provision an app skill; the
  exact-shape `checks` assertion gained the two keys. (Suite stays green; count grows.)
- **`minAppVersion: 0.1.29`** in the stub matches the running app (no version-gate disable; the
  registry does not enforce `compatibility` anyway in v1).
- **Integrity residual = accept + document (§22-M2):** the gate proves *provisioning*, not a runtime
  hash; trust is by drive location. Real integrity = off-drive signing (Tier-3). Same as the engine
  binary. Documented in security-model.md + known-limitations.md (with the DS20 confidentiality
  boundary + the DB-rebuild-resets-enable note — all three ratified entries landed together).

**Open landmines:** **SL-1 — RESOLVED in S9** (the instruction-skill `allowedTools` empties to `[]`, so
the tool-reserved signal needed the additive `reservesTools` flag rather than reading `allowedTools`).
No open `SL-#`. Carry-forward (not S9's job): the S6 composer-picker live eyeball still uncaptured
(needs a model-running walk step); covered by `SkillChat.test.tsx`.

**What S10 consumes:** the committed `schemas/transaction.schema.json` (the typed Tier-2 I/O contract
the tool registry validates against) + the `reservesTools`/`allowedTools` declaration on the stub (the
tool names the registry will wire); when the Tier-2 tools land (S11) the SKILL.md body is swapped to the
§6.6 reconcile/validate body and `allowedTools` becomes effective for a `kind: 'tool'` skill.

### Skills — S8 handoff (2026-06-17)

**Contracts produced** (what S9+ / a future S13 auto-fire consume):
- **`services/skills/selector.ts`** (pure, no DB): `scoreSkillTriggers(triggers, {question, docTitles,
  docMimeTypes}) → number`; `selectSuggestion(candidates, ctx) → SkillCandidate | null`;
  `SUGGEST_SCORE_THRESHOLD` (=2). Weights: keyword ×2, mime +1, filename +1 — a lone document signal
  is below threshold (never fires on "there's a PDF in scope" alone). Glob `*`/`?` filename matching,
  case-insensitive. Deterministic tie-break by `installId` asc. **The S13 confidence threshold tunes
  here; this same suite is its regression guard.**
- **`services/skills/suggest.ts`**: `suggestSkillsForTurn(db, conversationId, question?) →
  SkillSuggestion[]` — resolves scope via `resolveScope` + `buildScopeFilter` MAIN-side, candidates =
  `listSkills(db).filter(enabled && !unavailableAt)`, returns ≤1. Empty-tolerant (unknown/locked conv →
  keyword-only). **Read-only / inert** — never writes `active_skill_id`.
- **IPC**: `suggestSkills(conversationId, question?) → SkillSuggestion[]` (`shared/ipc.ts`
  `skills:suggest`, preload mirrored, handled in `registerSkillsIpc`; `requireUnlocked`; reconciles
  once then suggests; **no log/audit** — reads aren't audited and the question is content).
- **Shared type** `SkillSuggestion {installId, title}` (`shared/types.ts`) — structural only (§22-M1).
- **Renderer**: `SkillPicker` gains `suggestion?`/`onOpenChange?`; ChatScreen recomputes the offer on
  picker-open with the current draft + activeId. Key `chat.skill.suggested`; `.menu-item.skill-suggest`
  accent style.

**Decisions taken or changed:**
- **In-picker only (owner decision 2026-06-17):** the offer rides the picker the user already opened —
  no canvas chip, no `AppSettings` key (DS14/§22-D3). Recomputed on picker-open (one IPC per open with
  the live draft), not on every keystroke.
- **Threshold = 2 closes OQ-1** for v1: one keyword OR mime+filename together. Tunable in one constant.
- **Auto-fire stays deferred to S13** behind the offline evaluation harness (§10.4) — S8 ships only the
  inert one-tap offer. The selector is the harness's scoring unit when that lands.

**Open landmines:** none new (no `SL-#`). (The S6 composer-picker live eyeball is still the one
deferred capture — see the S6+S7 block; the picker incl. the new suggestion row is covered by
`SkillChat.test.tsx`.)

**What S9 consumes:** nothing from S8 directly — S9 commits the `app-skills/bank-statement/` instruction
stub (guidance-honest body + the detail-drawer Tier-2 note), wires `prepare-drive` copy + the
commercial-drive assert, and lands the **three ratified `known-limitations.md` entries** (§22-M2, DS20,
DB-rebuild-resets-enable — now bound into the §18.1 S9 spec + the §18.0-E doc-map). A real bundled
app skill will exercise the whole S2→S8 path end-to-end (its `triggers` make it the first real
selector candidate).

### Skills — S6+S7 handoff (2026-06-17)

**Contracts produced** (what S8 consumes):
- **`services/skills/turn.ts`**: `resolveTurnSkill(db, {appSkillsDir,userSkillsDir,limits?}, conversationId,
  requestedInstallId?) → TurnSkill | null` (requested `undefined`=sticky, `null`/`''`=none, string=that
  skill; skips disabled/deleted/unavailable) + `resolveTurnSkillFromRegistry(db, registry|undefined, …)`
  (the IPC wrapper). `TurnSkill = {installId, title, body}` (exported from `chat.ts`).
- **`services/skills/prompt.ts`**: `buildSkillFence({title,body}, budgetTokens?) → {text|null, omitted,
  trimmed}` (whole-paragraph reduction; omit-not-truncate); `skillFenceBudgetTokens({contextTokens,
  reserveTokens,fixedTokens})`; `composeSystemPromptWithSkill(base, fence)`; `approxPromptTokens`;
  `SKILL_GUARD_LINE`. Fence framing/guard are English (D-L6); body is author's language.
- **`chat.ts`**: `buildSystemPrompt(skillFence?)`, `buildChatMessages(db, convId, contextTokens?,
  skillFence?)`, `appendMessage({…, skillId?})`, `generateAssistantMessage(…, {skill?})`,
  `getConversationDefaultSkill`/`setConversationDefaultSkill`. `listMessages` LEFT JOINs `skills`
  (deleted → `skillId`/`skillTitle` NULL).
- **`rag/index.ts`**: `buildGroundedPrompt(question, chunks, skillFence?)` (fence in the USER turn);
  `generateGroundedAnswer(…, {skill?})` (stamps only when fence placed AND chunks found).
- **Shared types**: `Conversation.activeSkillId?`, `Message.skillId?`/`skillTitle?`,
  `ChatOptions.skillInstallId?`. **IPC**: `setConversationDefaultSkill(convId, installId|null)→void`;
  `askDocuments` gained a 3rd `skillInstallId?` arg. Preload mirrors both.
- **Renderer**: `renderer/chat/SkillPicker.tsx` (Radix RadioGroup, "None" + enabled skills) +
  the Transcript per-message glyph (`.msg-skill`). `chat.skill.{trigger,none,used,usedTitle}` keys.

**Decisions taken or changed:**
- **Budget approach (a), pre-size in `prompt.ts`** (not the yieldable-second-message option (b)):
  the fence is trimmed to `contextTokens − reserve − base − finalTurn (− excerpts)` BEFORE placement,
  so `fitMessagesToContext` (unchanged) only drops older history; base/final/excerpts never starve.
- **Stamp only when the fence was actually placed** (omitted-for-budget ⇒ no stamp), so the glyph is
  1:1 with a prompt that carried the skill (§22-A5/A6). No-context/listing answers stamp NULL.
- **Deleted-skill → NULL resolved at READ time via a LEFT JOIN in `listMessages`** (recommendation #2
  bound into code + a test) — a *disabled/unavailable* skill still shows the past glyph (row exists);
  only a truly deleted row drops it.
- **Renderer includes `skillInstallId` in `sendChatMessage` options only when non-null** (a cleared
  skill is the conversation's persisted null sticky default) — keeps no-skill turns' call shape and
  avoids churning existing chat tests.
- **`Conversation.activeSkillId` is OPTIONAL** in the type (additive; `rowToConversation` always
  populates it) so existing conversation fixtures stay valid.

**Open landmines:** none new (no `SL-#`). The S6 composer-picker **live eyeball was not captured**
(the chat composer's visibility in the walk harness depends on runtime state); the picker is identical
in styling to the shipped `DepthMenu` footer affordance and is covered by `SkillChat.test.tsx`
(picker behavior) + the Transcript glyph test. Not a blocker; flagged for the S8 walk to re-capture
once a model-running harness step is added.

**What S8 consumes:** the same enable/default surface; the picker is where the S8 deterministic
**"Suggested: …" one-tap offer** pins (DS14 — no settings key, no canvas chip). S8 adds
`services/skills/selector.ts` + a `suggestSkills(conversationId, question?)` IPC (scope resolved
main-side, §22-C4) scoring enabled skills' cached `manifest_json.triggers`; it is **inert until
picked** (never auto-applies — auto-fire is the deferred S13 wave).

### Skills — S5 handoff (2026-06-17)

**Contracts produced** (what S6 reuses):
- **`renderer/screens/settings/SkillsTab.tsx`** — the Settings → Skills surface. Components S6
  can reuse: `SkillRow`-style compact rows (icon · clickable title/desc · trailing chips/Switch/⋯),
  the `PermissionBlock` (the calm ✓/✕ capability list, **derived from the already-clamped
  `permissions` + `kind` — it localises the result, it never re-decides what a skill may do**), and
  the detail `Modal` drawer. All internal to the file (no new exported component module — S6 lifts
  what it needs).
- **Nav:** `SettingsTab` (`renderer/navigation.ts`) gains `'skills'`; `resolveNavTarget`
  resolves `settings:skills` → `{ screen: 'settings', settingsTab: 'skills' }`. `SettingsScreen`
  `TAB_CHOICES` order is General · Skills · Privacy · Diagnostics. **[superseded — Skills is now a
  top-level rail destination (`ScreenId 'skills'`), not a Settings tab; `settings:skills` is kept as a
  legacy alias resolving to `{ screen:'skills' }`. See the top status entry.]**
- **i18n:** ~70 `skills.*` keys + `settings.tab.skills` in BOTH catalogs (EN/DE, informal „du").
  Parity test green.
- **CSS:** `.skills-toolbar/.skills-intro/.skills-list/.skill-row*/.skill-perm*/.skill-import`
  in `renderer/styles.css` (modelled on the Documents `.doc-row` pattern; tokens-only).

**Decisions taken or changed:**
- **Permission display is rendered from the structural `permissions` object + `kind`, NOT from the
  `permissionSummary` string.** `summarizeSkillPermissions`/`permissionSummary` is a single English
  sentence (computed main-side); the §15 spec mandates a localised ✓/✕ "can / cannot" block, so the
  renderer maps the **already-clamped** enum values to EN/DE catalog copy. This is presentation, not
  re-validation (DS6 clamping stays main-authoritative) — it keeps the German UI honest where the
  raw `permissionSummary` would leak English. `permissionSummary` remains available on
  `SkillInfo`/`SkillPreview` for any non-localised use (S6 picker tooltip, etc.).
- **Import is a dropdown (file / folder), not a single button.** `pickSkillPackage` needs a `mode`
  (Windows can't mix file+dir in one OS dialog — S4 §22-A2 note), so "Import skill…" opens a
  Radix menu with **From a file (.skill.zip)…** + **From a folder…**, each calling `pick(mode)`.
- **The detail drawer reads the row's `SkillInfo` directly** (it carries every field) rather than
  round-tripping `getSkill` — fewer IPC calls, and the open drawer is re-synced to the freshest row
  after any mutation via a `useEffect` keyed on the refreshed list. `getSkill` stays available but
  unused by S5.
- **Enable of a `duplicateId` skill shows a "replace the other?" ConfirmDialog first** (DS12), then
  calls `enableSkill`; the server still enforces one-active-per-id, so the prompt only surfaces the
  intent. Disable never prompts. Every mutation (`enable/disable/import/delete/acknowledge`)
  re-`list()`s so sibling state (the disabled-other) reflects immediately.
- **Confirm is blocked (button `disabled`) when `preview.ok === false` OR `downgradeBlocked`**
  (DS15); the dialog still renders the structural `errors`/`notes` + the collision/upgrade/replace/
  downgrade banners so the user sees *why*.
- **No `design-guidelines.md` change** (§18.0-E): the skill row reuses the `.doc-row` §11.6 pattern
  and the ✓/✕ block is a skill-specific content layout (Badge/list idioms), not a new broadly-
  reusable pattern. Recorded here per the doc-map.

**Open landmines:** none new (no `SL-#` opened in S5).

**What S6 consumes:** the same `window.api` enable/default surface S4 produced; the `SkillInfo`
shape + `PermissionBlock`/drawer presentation it can lift from `SkillsTab.tsx`; the
`messages.skill_id` stamp (S6/S7) + the carry-forward invariant — **the glyph/turn-skill read MUST
resolve a deleted/vanished `messages.skill_id` to NULL** (no FK; S4 delete relies on it). The
composer picker, the "Using skill" chip, the per-message glyph, `resolveTurnSkill`, and the prompt
fence are **S6/S7 — NOT built in S5**.

### Skills — S4 handoff (2026-06-17)

**Contracts produced** (what S5–S8 import):
- **Shared types** (`shared/types.ts`): `SkillInfo` (decoded `skills` row + `permissionSummary` +
  `duplicateId` + `unavailable`) and `SkillPreview` (manifest summary + permission summary +
  collision/upgrade/downgrade/downgradeBlocked flags + structural `errors`/`notes`). **NEW frozen
  contract** — S5 (list/import drawer), S6 (picker), S8 (selector) consume these. `shared/skill-manifest.ts`
  gains `summarizeSkillPermissions(perms) → string` (pure, structural, shared with the renderer).
- **IPC channels** (`shared/ipc.ts` + `preload/index.ts`, all 1:1): `skills:list` `()→SkillInfo[]`,
  `skills:get` `(installId)→SkillInfo|null`, `skills:pick` `(mode?: 'file'|'folder')→path|null`,
  `skills:preview` `(source)→SkillPreview` (NO write), `skills:import` `(source)→SkillInfo`,
  `skills:export` `(installId)→path|null` (save dialog), `skills:delete` `(installId)→void`,
  `skills:enable`/`skills:disable` `(installId)→SkillInfo`, `skills:acknowledgeWarning`
  `(installId)→SkillInfo`. All DB-backed handlers `requireUnlocked` (friendly `main.skills.locked`);
  validation is resolved MAIN-side only (preview is the single truth — the renderer never re-validates).
- **`services/skills/installer.ts`** signatures: `previewSkillPackage(db, source, deps, {developerMode?})
  → SkillPreview`; `importSkill(db, source, deps, {developerMode?}) → {info: SkillInfo, fileCount}`;
  `exportSkill(db, installId, destPath, deps) → number`; `deleteSkill(db, installId, deps) →
  {deleted}`; `recordToInfo(record, duplicateId)`/`skillInfo(db, record)`. `SkillInstallerDeps =
  {appSkillsDir, userSkillsDir, limits?, now?}`. Exports `SkillImportError` + `SKILL_IMPORT_ERRORS`
  (the fixed structural reason strings).
- **Audit events** (`shared/types.ts` `AuditEventType`): `skill_imported`, `skill_deleted`,
  `skill_enabled`, `skill_disabled` — metadata `{id, source[, fileCount]}` ONLY (ids/counts, §22-M1).
  Diagnostics labels + EN/DE catalog keys added (`diag.audit.skill_*`).
- **Registry change** (`services/skills/registry.ts`): `createSkillRegistry` now reconciles disk→DB
  **once per session on the first `list()`/`get()`** (a `reconciledThisSession` guard set only on a
  successful reconcile; a read while locked retries next call). `reconcile()` still forces it.

**Decisions taken or changed:**
- **ZIP MECHANISM (the §22-A2 contract): a net-new, DEPENDENCY-FREE extractor** — Node's built-in
  `node:zlib` (`inflateRawSync` with `maxOutputLength` as the authoritative zip-bomb backstop) + a
  hand-rolled zip **central-directory** reader (the `declaredZipInflatedSize` style). NOT JSZip, NOT
  the validation-blind shell-tar path. Reads every entry from the central directory BEFORE inflating;
  STORE+DEFLATE only; encrypted/ZIP64 refused. Export writes a minimal STORE-method zip the same way.
  (JSZip appears ONLY in test fixtures, via the existing transitive dep — zero new runtime dependency.)
- **Collision + DS7 interplay (refines DS12):** a view-import installs **enabled-with-warning**, BUT
  if an **enabled app skill** shares the id it installs **disabled** (coexist) so a user skill can
  never silently shadow trusted product content (trust-first). **Enable enforces one-active-per-id**
  server-side (enabling X disables same-id siblings) — the "offer to disable the other" is realized as
  an invariant the S5 UI just surfaces.
- **Delete-during-active-stream:** handled by the documented rule "a stamp whose skill vanished
  mid-turn resolves to NULL" + a single transaction (so a reader never sees a row-gone-but-refs-present
  half state). The registerSkillsIpc layer has no in-flight set; S6's glyph read must tolerate a
  missing skill (resolve→NULL). No SL opened.
- **Export is not a distinct audit event** in v1 (plan §16 enumerates import/delete/enable/disable);
  a local log line suffices (the chosen path is user-private).

**Open landmines:** none new (no `SL-#` opened in S4). One carry-forward for S6: the glyph/turn-skill
read MUST resolve a vanished/deleted `messages.skill_id` to NULL (the delete path relies on it; there
is no FK and no stream guard in the skills IPC layer).

**What S5 consumes:** `window.api.{listSkills,getSkill,pickSkillPackage,previewSkillPackage,importSkill,
exportSkill,deleteSkill,enableSkill,disableSkill,acknowledgeSkillWarning}` + the `SkillInfo`/
`SkillPreview` shapes + `summarizeSkillPermissions` for the permission-summary line; the import drawer
shows `SkillPreview.permissionSummary` + collision/downgrade flags before calling `importSkill`; the
list renders `SkillInfo.{enabled,warningAck,duplicateId,unavailable,permissionSummary}`. (S6 consumes
the same enable/default surface + `messages.skill_id`; S8 consumes cached `manifest_json.triggers`.)

### Skills — S3 handoff (2026-06-17)

**Contracts produced** (what S4–S9 import):
- **Schema** (`services/db.ts`): additive `skills` table (full SQL in `SCHEMA`, `IF NOT EXISTS`) +
  nullable `conversations.active_skill_id` + `messages.skill_id` (ensureColumn). Columns:
  `install_id` (PK), `id`, `title`, `version`, `kind`, `source`, `path`, `enabled`, `warning_ack`,
  `trusted_level`, `manifest_json`, `unavailable_at`, `installed_at`, `updated_at`; `idx_skills_id`
  on `id`. **No FK from any core table into `skills`** (audit C3) — refs are cleared by an app-level
  sweep in S4, never a cascade.
- **`services/skills/registry.ts`**: `reconcileSkills(db, {appSkillsDir, userSkillsDir, limits?, now?})
  → ReconcileResult {inserted, updated, markedUnavailable, present, errors}`; `discoverSkillsInDir(dir,
  source, {limits?})`; `listSkills(db)`, `getSkill(db, installId)`, `getSkillsByDeclaredId(db, id)`,
  `setSkillEnabled(db, installId, enabled, now?)`, `markSkillUnavailable(db, installId, now?)`,
  `skillInstallId(source, id)`. Types: `SkillRecord`, `SkillSource` (=`SkillTrustedLevel`),
  `DiscoveredSkill`, `ReconcileResult`. The handle: `createSkillRegistry({getDb, appSkillsDir,
  userSkillsDir, limits?}) → SkillRegistry {appSkillsDir, userSkillsDir, reconcile(), list(), get(),
  setEnabled()}`.
- **`services/skills/loader.ts`**: `loadSkillPackage(record, {appSkillsDir, userSkillsDir, limits?})
  → SkillParseResult`; `loadSkillFromDir(dir, {limits?})`; `skillRecordDir(record, opts)`. ONE mode —
  reuses S2's `parseSkillManifestFromDir`; no decrypt/transient/shred.
- **`services/drive.ts`**: `DRIVE_LAYOUT_DIRS` now contains `app-skills`+`user-skills` (after
  `workspace`); both `scripts/prepare-drive.{ps1,sh}` updated to match (script-drift parity).
  `resolveAppSkillsDir(rootPath, appPath?)` (on-drive → repo-source dev fallback) +
  `resolveUserSkillsDir(rootPath)` (always `<root>/user-skills`).
- **`AppContext.skills?: SkillRegistry`** (`services/context.ts`), wired in `main/index.ts` with a
  best-effort startup reconcile.

**Decisions taken or changed:**
- **PK = deterministic natural key `install_id = "<source>:<id>"`** (NOT a random uuid) — the OPEN
  decision §0/§8.2 left to S3. Rationale: under revised §0 user-skill folders are named by `id`, so
  two same-id user skills can't coexist on disk; a disk-derived key is **stable across a DB rebuild**,
  so the FK-less `conversations.active_skill_id`/`messages.skill_id` refs keep resolving (a re-minted
  uuid would orphan them — the very thing §0 promises against). Same-id app vs user → distinct keys
  (`app:x` / `user:x`), so DS12's collision handling holds. `path` stores the folder **basename**
  (relative to its source dir), resolved by the loader — portable, no machine-specific absolute path.
- **Added column `skills.unavailable_at`** (NULL = present; ISO ts = folder vanished) — not in the
  §8.2 sketch, but required to persist the "mark-unavailable, never blind-delete" flag (DS1/§7.4). The
  NULL-sentinel convention (`scope_v2_json` precedent).
- **Reconcile insert-vs-update split is load-bearing:** a NEW row applies the source default
  (app → enabled+ack; user drop-in → disabled, DS19); an EXISTING row re-derives cached fields but
  PRESERVES `enabled`/`warning_ack` and only writes when something actually changed (idempotent — no
  spurious `updated_at` bumps). Consequence: a DB rebuild re-derives user skills as **disabled** (they
  must be re-enabled) — consistent with DS19 (a rebuild is a fresh discovery, not a confirmed import).
- **Discovery rejects** a folder whose name fails `SKILL_ID_RE` or whose SKILL.md fails validation
  (error + skip); silently skips a folder with no SKILL.md; dedupes same-`id` within a source (first
  wins). Trust is APP-assigned (app dir → `app`, user dir → `user`); a self-declared `trust` is already
  ignored by the S2 parser.

**Open landmines:** none new (no `SL-#` opened in S3). Two residuals carry RATIFIED guidance (owner,
2026-06-17) — spec for S4, not landmines:
- **Post-unlock reconcile is not yet wired** (the startup reconcile is best-effort and no-ops while an
  encrypted DB is locked). **Ratified approach for S4: lazy reconcile-once-per-session on first registry
  read** — add a `reconciledThisSession` guard inside `createSkillRegistry` so the first `list()`/`get()`
  after unlock reconciles, and have the S4 importer/deleter call `reconcile()` explicitly after they
  mutate disk. NOT an unlock-handler hook (keeps skill I/O off the crowded unlock critical path; covers
  plaintext + encrypted uniformly; chat resolves a sticky default via the persisted row regardless).
- **A workspace DB rebuild resets user-skill `enabled`/`warning_ack` to the drop-in default (disabled).**
  **Ratified: accept + document** — it is the safe direction (DS19), and persisting enable-state in a
  per-folder marker would split state across disk+DB and break "the table is a pure cache." Add one line
  to `known-limitations.md` at S9/S12: *"a workspace DB rebuild resets skill enable/acknowledgement
  state; skills must be re-enabled."*

§22-M2 (app-skill integrity residual) + DS20 confidentiality boundary stay documented-as-known-limitations
for S9.

**What S4 consumes:** the `skills` table + `SkillRecord`/registry functions (installer upserts via the
same row shape, sets `enabled`+`warning_ack` for a view-import per DS7, clears refs on delete per C3);
`resolveAppSkillsDir`/`resolveUserSkillsDir` + `resolveSkillLimits` for the new safe extractor that
unzips a `.skill.zip` straight into `user-skills/<id>/` (**ratified: importer writes the folder named by
`id` so folder-name == manifest `id` always agree; the drop-in path already tolerates a mismatch**);
`loadSkillPackage` for preview; `markSkillUnavailable`/`reconcileSkills` for the post-delete/post-import
refresh. (S6/S7 consume `messages.skill_id` + `conversations.active_skill_id`; S8 consumes cached
`manifest_json.triggers`.)

### Skills — S2 handoff (2026-06-17)

**Contracts produced** (frozen — the spine every later phase imports, §18.0-B):
- `shared/skill-manifest.ts` types: `SkillManifest`, `SkillPermissions`, `SkillTriggers`,
  `SkillCompatibility`, `SkillKind` (`'instruction'|'tool'`), `SkillTrustedLevel` (`'app'|'user'`),
  `SkillDocuments/Filesystem/NetworkPermission`, `SkillManifestValidation`, `SkillParseResult`,
  `SkillParseOptions`. Functions: `parseSkillMarkdown(source, opts)`, `validateSkillManifest(raw)`.
  Consts: `SKILL_ID_RE` (`^[a-z0-9][a-z0-9-]{1,62}$`), `SKILL_SEMVER_RE` (strict MAJOR.MINOR.PATCH),
  `SKILL_V1_PERMISSION_CEILING`, `SKILL_KINDS`, `SKILL_TRUSTED_LEVELS`, `DEFAULT_SKILL_MAX_BODY_CHARS`.
- `SkillManifest` carries `triggers` + `compatibility` and JSON-round-trips unchanged (audit **C2**
  proved by test) — S3 caches it verbatim into `skills.manifest_json`. `trustedLevel` is NOT on the
  manifest (app-assigned by the registry in S3); a self-declared `trust` field is ignored with a note.
- `services/skills/manifest.ts`: `parseSkillManifestFromDir(dir, {limits?})` +
  `parseSkillManifestSource(source, {limits?, manifestJson?})` — the main-side validation entry points.
- `services/skills/limits.ts`: `SkillLimits`, `DEFAULT_SKILL_LIMITS`, `resolveSkillLimits(env?)`.
- **New env caps** (§6.4, no doc change needed per §18.0-E — recorded here): `HILBERTRAUM_SKILL_MAX_FILE_BYTES`
  (1 MiB), `_MAX_TOTAL_BYTES` (8 MiB), `_MAX_FILES` (200), `_MAX_PATH_LEN` (255), `_MAX_DEPTH` (4),
  `_MAX_BODY` (64 KiB). Only `maxBodyChars` is enforced in S2 (the parser); the rest are consumed by
  the S4 extractor.

**Decisions taken or changed:**
- **Permission ceiling resolves by CLAMPING, never failing** (DS6 / §6.7 / §17). The §6.6 frontmatter
  comment "a non-'denied' network value *fails validation*" is superseded: a recognized-but-broader
  value (e.g. `network: allowed`, `documents: all`) is clamped DOWN to the ceiling with a non-fatal
  note; an absent or unrecognized value resolves to the ceiling (the default instruction posture — it
  can never exceed the ceiling, so this is not an elevation). This matches DS6 "restrict-only" and the
  §17 "permission-ceiling clamping" test wording. (Note kept here, not a plan edit, since the plan's
  normative text already says clamp.)
- Frontmatter accepts both camelCase (the §6.6 canonical form) and snake_case for multi-word keys
  (`minAppVersion`/`min_app_version`, `mimeTypes`/`mime_types`, `filenamePatterns`/`filename_patterns`,
  `allowedTools`/`allowed_tools`). Unknown keys are ignored. Required fields: `id`, `title`,
  `description`, `version`; `kind` defaults to `instruction`.
- `DEFAULT_SKILL_MAX_BODY_CHARS` lives in `shared/skill-manifest.ts`; `limits.ts` imports it so the
  body cap has one source of truth.

**Open landmines:** none (no `SL-#` opened in S2). The §22 items remain spec, not landmines.

**What S3 consumes:** the `SkillManifest` shape + `parseSkillManifestFromDir` (registry discovers
app-skills folders → parse → assign `trustedLevel` → upsert `skills` row with `manifest_json` =
JSON.stringify(manifest)); `resolveSkillLimits()` for the loader/installer; `SKILL_ID_RE` for the
on-disk-name safety check. S3 still owns the table, reconcile, loader, `DRIVE_LAYOUT_DIRS`/`app-skills`,
and the `shredStalePlaintext` extension (audit A3/A4/C1).

_(prior) 2026-06-16 — **Skills feature — durable design plan written (planning only, NO
code).** ⚠️ **HISTORICAL SNAPSHOT — partially SUPERSEDED. Do not treat as the current contract.** Two
decisions in this block were later revoked and the as-built design lives in the architecture.md "Skills
— design record (§1–§12)": **DS11 (encrypted blob per user skill, decrypted to a shredded transient)
was REVOKED** — user skills are now plain unencrypted folders under `user-skills/` outside the workspace
(DS3/DS19/DS20; the loader has one mode, no decrypt/shred); and the **`skill_selected` audit event (DS13)
was never built** — selecting a skill is an unaudited sticky-default write (there is no such
`AuditEventType`). The rest of the block (DS1/DS2/DS4–DS10/DS12/DS14–DS18) holds. New working paper
[`docs/skills-plan.md`](docs/skills-plan.md): local, user-installable
**Skills** (instruction packages that inject reviewed prompt text; Tier-2 app-owned tools designed
but deferred; Tier-3 script execution excluded). Key decisions: files-on-disk are truth + `skills`
table is a reconciled index (DS1, the `services/models.ts` pattern); `SKILL.md` YAML frontmatter
canonical via a shared `shared/skill-manifest.ts` (DS2); **user skills live INSIDE the encrypted
workspace (`workspace/skills/`, `.enc`), app skills OUTSIDE (`app-skills/`, read-only)** (DS3);
v1 selection is manual/deterministic with no model-native tool calling (DS4); skill text is a
fenced system section with fixed precedence below the base + grounding rules + a guard line (DS5);
permissions are app-computed `min(declared, ceiling, grant)`, never self-granting (DS6). Additive
schema only (`skills`/`skill_runs` tables + nullable `conversations.active_skill_id`); no CSP/
permission/offline/packaging changes. Phased S1–S12 (S1 = this plan). **Q1–Q9 RESOLVED + refined
with the owner (DS7–DS18):** imports install **enabled-with-warning** (DS7, `skills.warning_ack`);
**one encrypted blob per user skill** `<install_id>.skill.zip.enc`, decrypted to a shredded
transient on activation, app skills stay plain folders (DS11); **duplicate ids COEXIST with a
warning, one active per id** — table keyed by generated `install_id`, declared `id` non-unique
(DS12, revised from reject); **`skill_runs` not in v1** — added with Tier-2, v1 uses the
`skill_selected` audit event (DS13); trigger = **one-tap suggestion inside the picker** in v1, no
settings key (DS14) — **auto-fire deferred to Phase S13 behind an offline evaluation harness**
(precision/recall over a labelled corpus + threshold + undo + opt-in; not a security blocker since
enable/disable bounds candidates, §10.4); downgrade **dev-mode only** (DS15); literal assembled fence
**developer-mode only** + a per-message glyph backed by `messages.skill_id` (DS16); app skills
**committed to the repo, copied by prepare-drive** (DS17); **one skill per TURN, many per
conversation** — `messages.skill_id` per turn + `conversations.active_skill_id` as the sticky
default; per-turn skill rides `ChatOptions.skillInstallId` on send (DS18, reframed from
per-conversation). New schema: `skills` table (PK `install_id`) + nullable
`conversations.active_skill_id` + `messages.skill_id`. A dedicated **Settings → Skills** screen with
an **Import** button (pick → validate → encrypt → store) is the add-flow. **Plan then AUDITED
(4 personas, repo-grounded) and REMEDIATED in place — see skills-plan.md §22.** Headline fixes
folded back: (A1) skills must reach BOTH chat IPC AND the separate `askDocuments` RAG channel via a
shared `resolveTurnSkill()` (else document conversations silently drop the skill); (A2) **no
reusable safe zip extractor exists** — `.skill.zip` needs a NEW member-by-member extractor and must
never hit the validation-blind `tar -xf`; (A3) the crash-sweep is hard-scoped to
`workspace/documents/` — extend `shredStalePlaintext` to `workspace/skills/` (the "crash-sweep
covered" claim was false); (A4) `app-skills` must enter `DRIVE_LAYOUT_DIRS` + drive-layout.md in
**S3**, not S9; (A5) `messages.skill_id` stamps the **assistant** row (OQ-4 resolved) — a 5–6
call-site + `appendMessage` API change; (A6) the fence can't just append to the system message or it
silently starves history. Precedent-claim corrections: `policy.ts` is a boolean AND not a 3-way
`min()`; `buildSystemPrompt()` is an arg-less pass-through (needs a seam); untrusted skill text goes
in the **user/data turn** (RAG) like excerpts, not `system`; "mark-unavailable" is a NEW helper, not
a collections precedent. Coherence: user-skill blobs orphan on DB rebuild (added orphan-recovery
reconcile); `manifest_json` MUST carry `triggers`; doc-menu "Use a skill…" deferred to Tier-2;
bank-statement v1 stub body made guidance-honest. **Still S1 — plan only; no code, no schema, no
version bump.** Non-blocking impl-time items remain (OQ-1..3; OQ-4 now resolved). Next: Phase S2
(package schema + parser), carrying the §22 corrections into S3/S6/S7/§16._

_(prior) 2026-06-16 — **Dev-setup bugfix: Electron's platform binary silently fails to
extract onto an NTFS-on-Linux mount (beta builder report).** A Linux dev setting up the drive on an
NTFS (ntfs-3g/FUSE) volume hit electron-vite's opaque `Electron uninstall` ("binary not found"). Root
cause: `npm install` ran Electron's postinstall, the ~113 MB download succeeded (valid zip in
`~/.cache/electron`), but `extract-zip` **silently dropped the binary** when writing onto the NTFS
mount — leaving only an empty `dist/locales/`. And because the lockfile then matched, npm considered
electron installed and **never re-ran its postinstall**, so a repeat `npm install` couldn't repair it;
the breakage only surfaced much later at launch. **Fix:** new root **`postinstall`**
(`scripts/verify-electron.mjs`, cross-platform Node — NOT a `.ps1/.sh` mirror) that runs on EVERY
`npm install` (cached deps or not). It mirrors `electron/index.js`'s own logic (read `path.txt` →
`dist/version` → `dist/<binary>` exists & non-empty); on a healthy install it's a couple of stat()s
and exits 0. When broken it removes the half-written `dist/`, force-re-runs `electron/install.js`
(re-extract from the cached zip), re-verifies, and on persistent failure **exits non-zero with an
actionable message** (put `node_modules` on a native fs — ext4/Btrfs/APFS; the portable DRIVE can
stay NTFS) instead of letting the opaque error surface later. Honors `ELECTRON_SKIP_BINARY_DOWNLOAD` /
`ELECTRON_OVERRIDE_DIST_PATH` / `HILBERTRAUM_SKIP_ELECTRON_CHECK`. **Files:** `package.json`
(root `postinstall`), `scripts/verify-electron.mjs` (new). **Docs:** `CONTRIBUTING.md` (Dev setup
warning), `docs/packaging.md` (scripts table row). **Tests:** detection logic exercised against
half-extract / missing-binary / empty-binary / healthy fixtures (all correct); `npm run postinstall`
green on the real (healthy) install. No version bump, no schema change._

_(prior) 2026-06-16 — **Bugfix: chat/RAG failed with `HTTP 400 exceed_context_size_error`
on a long analysis session + the friendly error never showed (beta-tester report).** Symptom: a
tester analysing a 5-page bank statement hit `ChatRequestError: Chat request failed: HTTP 400 —
request (9600 tokens) exceeds the available context size (8192 tokens)` — and saw that RAW string,
not the friendly copy. **Two distinct root causes.** (1) **Overflow:** `buildChatMessages`
(plain chat) and `buildGroundedChatMessages` (RAG) replay the WHOLE persisted history with no
budget against the model context — only the retrieval cap `ragMaxContextTokens` (2500) bounded the
*retrieved chunks*, never the *total* prompt. An accumulating multi-turn conversation (history +
a fresh chunk block + system + template) crept past `contextTokens` and llama-server rejected it
before generation. The doc-task windows already sized inputs to `contextTokens`; the conversational
path was the gap left by the 0.1.20 fix. (2) **Dead friendly mapping:** the overflow IS mapped to
`main.model.contextExceeded` in `withChatStream`, but that text was sent only over the `chat:error`
event — which the renderer's `stream()` never subscribes to. The renderer surfaces the invoke
REJECTION, and `withChatStream` re-threw the RAW error; `friendlyIpcError` then only stripped an
`Error:` prefix, not the `ChatRequestError:` subclass name → the raw HTTP 400 + class name leaked.
**Fixes:** (1) new `fitMessagesToContext` (chat.ts, single owner) trims history to fit
`contextTokens` — keeps leading system message(s) + the FINAL turn (current question/grounded
prompt, never dropped), drops older turns oldest-first as a **contiguous tail** (role alternation
preserved), with a `CHAT_RESPONSE_RESERVE_TOKENS` (1024) answer headroom. Both builders take an
optional `contextTokens` (production passes `getSettings(db).contextTokens`; omitted = pure builder
for tests); `generateAssistantMessage` + `generateGroundedAnswer` thread it. (2) `withChatStream`
now THROWS the mapped friendly message on overflow (so the invoke rejection the renderer shows is
friendly), and `friendlyIpcError` strips any `WordError:` class-name prefix. Raw reason still goes
to the local log only. **Files:** `services/chat.ts`, `services/rag/index.ts`, `ipc/chat-stream.ts`,
`renderer/lib/errors.ts`. **Docs:** `architecture.md` ("Chat & streaming" — history budget + error
surfacing), `rag-design.md` (grounded assembly now whole-prompt budgeted), `known-limitations.md`
(third instance of the token-budget class). **Tests:** typecheck clean, full vitest **1375 passed /
25 skipped** (+10: `fitMessagesToContext` keep/trim/contiguous-tail/oversize-last, `buildChatMessages`
+ `buildGroundedChatMessages` trim, `withChatStream` overflow→friendly on event AND rejection,
`friendlyIpcError` subclass-name stripping). No version bump, no schema change._

_(prior) 2026-06-16 — **Adaptive Home CTA + one app-wide privacy indicator + AI-Model
de-jargon.** A **renderer + EN/DE i18n only** wave (no IPC/schema/data-contract/main-process logic
changes), folded into [`design-guidelines.md`](docs/design-guidelines.md) **§11.7** (new record),
**§11.3 D-UI3** (hero now adaptive), and **§12.1 #2** (single indicator moved, superseded note).
**(A) Home hero CTA adaptive (D-UI3).** Home led with a loud "Start chatting" even while the hub
showed "⚠ Needs a model", dead-ending at the no-model empty state. The hero is now driven by the
SAME readiness signal as the row badges (`needsModel = status != null && !modelRunning &&
!status.activeModelId`): needs-a-model → loud primary **"Choose a model" / „Modell auswählen"** (→
AI Model), with "Start chatting"/"Ask my documents" demoted to secondary (still clickable, never
hard-disabled); ready → loud **"Start chatting" / „Chat starten"**. Exactly one loud primary; the
model row keeps its own *secondary* "Choose a model". No new state. **(B) One app-wide privacy
indicator (§1.2/§7).** Reversed §12.1 #2 (chat-header-only, which left Home/Documents/AI
Model/Settings with no signal). Revived the dormant `LocalIndicator variant="sidebar"` +
`.local-indicator-sidebar` CSS at the **foot of the app rail** (restyled to match the rail —
icon-over-short-label, 12px floor, quiet/muted), removed the chat-header instance → **exactly one**
signal on every screen. Reflects the EFFECTIVE state (`PolicyStatus.offlineMode`, App-owned: folds
the policy ceiling AND the network toggle — policy-forces-off reads "Offline" even with the toggle
on): off → closed padlock + **"Offline"**; allowed → open padlock (new `lock-open` `Icon` glyph) +
**"Downloads on" / „Downloads an"** (tooltip "Downloads allowed — chats and documents stay local").
Short one-word rail labels (`indicator.short.*`); full reassurance in the tooltip; wraps at its
space like "AI Model". Click → `settings:privacy` (unchanged). **(C) AI Model de-jargon (§3/§7).**
"Start mock runtime" / „Demo-Runtime starten" → **"Try in demo mode" / „Im Demo-Modus testen"** (+
de-jargoned start-title & `diag.accel.mock`); the affordance is already developer-gated in MAIN
(`startableAsMock = missing ∧ chat ∧ developerMode`), so end users never see it — relabel chosen
over hiding. Per-card tidy: the disabled **Select** (and the disabled Start-runtime on a no-mock
card) is **hidden until downloaded** → a "Not downloaded" card's one clear action is **Download**
(+ demo on the dev path); Select returns once installed. **Files:** `HomeScreen.tsx`, `App.tsx`,
`ChatScreen.tsx` (drop header indicator + `offline` prop), `LocalIndicator.tsx`, `Icon.tsx`
(`lock-open`), `ModelsScreen.tsx`, `styles.css`, `shared/i18n/{en,de}.ts`. **Tests:** typecheck +
`npm run build` clean; full vitest from `apps/desktop` **1365 passed / 25 skipped** (IA single
rail-foot indicator + honest "Downloads on"; `LocalIndicator` short-label/honest-state; `ChatHomeNav`
adaptive-CTA incl. exactly-one-loud-primary + both locales; `ModelsScreen` no-disabled-Select +
"Try in demo mode"; removed the obsolete chat-header-indicator test; copy-tone bans "Start mock
runtime"/„Demo-Runtime"). Playwright `_electron` eyeball walk BOTH themes AND both locales (EN/DE):
Home needs-a-model vs ready; rail-foot indicator on all five screens OFF vs ON; AI Model cards —
captures in `docs/design-review/home-privacy-aimodel/` (`scripts/walk-home-privacy-aimodel.mjs`).
**No version bump, no schema change. Next:** open work unchanged (Phase 30 big-slot/embeddings —
D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Docs-screen-refinement polish: rail label hyphenation +
import-failure copy + failed-row actions + sub-nav density.** A renderer-only wave (plus the one
scoped main-process user-facing string exception, §11.2) on the Documents screen + app shell,
folded into [`design-guidelines.md`](docs/design-guidelines.md) **§12.1 #1** (rail) and **§11.6**
(extended, §-anchors stable). **No IPC/schema/data-contract changes.** **(A) Rail labels never
break mid-word.** The compact app rail hyphenated long labels ("Docu-ments"/"Doku-mente"/
"Einstel-lungen") via soft hyphens (U+00AD) baked into the i18n strings + `hyphens: manual`. Fixed:
soft hyphens **stripped** from `nav.documents`/`nav.settings` (EN+DE); `.nav-label` →
`hyphens: none; overflow-wrap: normal; word-break: normal`; the `.app-shell` grid column **widened
80px → 100px** so the longest single-word label ("Einstellungen", DE, ~72px) fits one line at the
**12px floor** (the label was also 11px → 12px); narrow breakpoints (≤760/≤520px) no longer shrink
below the fit width. **(B) Import-failure copy localized + softened (§7).** The raw English
`Unsupported file type: .xyz` (persisted + shown, leaking English into the German UI) now routes
through a new **interpolated** persist-canonical key `main.ingest.unsupportedType` (`{ext}` param;
EN "This file type isn't supported (.xyz). Try TXT, PDF, DOCX, CSV, or a supported audio format.",
DE informal „du"). [`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts) persists
canonical English via `t('en', …, {ext})` (preview sibling uses `tMain`); the D-L4 display map
([`displayMap.ts`](apps/desktop/src/renderer/lib/displayMap.ts)) gains an **interpolated matcher**
(template→regex recovers `{ext}`, re-renders in-language) + a **legacy matcher** so pre-change rows
still localize. The key is OUTSIDE `DISPLAY_MAP_KEYS` (exact set) → new `INTERPOLATED_MAP_KEYS`;
copy-tone guard now bans the raw literal. **(C) Failed-row actions.** A failed import has no text →
**Preview is meaningless**; failed rows now show inline **Remove** (reuses the delete handler;
clearable from BOTH the All-docs list and "Failed imports" view) and **Try again** (re-index) ONLY
when retryable (`isRetryableFailure` — false for unsupported-type/file-too-large/too-many-sections);
no "⋯" on a failed row. The red Failed badge + in-context banner stay, banner now **compact**
(`.doc-row-main .banner`). **(D) Sub-nav density** tightened (inter-group `8px→3px`, head `4px→2px`,
group label `11px→12px`). **Files:** `shared/i18n/{en,de}.ts`, `ingestion/index.ts`, `displayMap.ts`,
`DocumentsScreen.tsx`, `styles.css`. **Tests:** typecheck + `npm run build` clean; full vitest from
`apps/desktop` **1356 passed / 25 skipped** (display-map interpolated/legacy/hygiene; DocumentsScreen
failed-row Remove/Try-again/no-Preview + `isRetryableFailure`; new `rail-labels` guard; copy-tone
stale-literal; ingestion softened-English; i18n soft-hyphen strip). Playwright `_electron` eyeball
walk BOTH themes AND both locales (EN/DE): rail on all five screens (labels measured one-line/
unclipped, longest "Einstellungen" 72px/100px col), failed import (localized banner, Remove not
Preview, compact banner), "Failed imports" view — captures in `docs/design-review/rail-and-failed/`
(`scripts/walk-rail-and-failed.mjs`). **No version bump, no schema change. Next:** open work
unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documents screen: suggested-project FEATURE REMOVAL + sub-nav
regroup/collapse.** Two changes folded into [`design-guidelines.md`](docs/design-guidelines.md)
**§11.6** (extended, §-anchor stable). **(A) Removed the auto "suggested project" feature** —
an intentional product decision (it surfaced a near-equal row affordance for a low-value guess).
Deleted across the stack: the per-row suggestion chip + Apply/Dismiss + renderer state
([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)); the read-only
`docs:filingSuggestions` IPC handler ([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts))
+ its preload bridge + the `IPC.filingSuggestions` channel; the pure rule engine
`services/filing-suggestions.ts` (**deleted**); the `FilingRuleId`/`FilingTarget`/`FilingSuggestion`/
`FilingSuggestionResult` types + the `AppSettings.dismissedFilingSuggestions` setting (+ default)
([`shared/types.ts`](apps/desktop/src/shared/types.ts)); the `docs.suggest.*` i18n keys (EN+DE);
the `.doc-suggest*` styles. Filing stays fully manual via the row **⋯** / selection toolbar
(`addToCollection`/`createCollection`). `source_folder_label` import metadata is **retained**
(generic ingestion metadata, not suggestion-specific); the generic string[]-setting sanitizer in
[`settings.ts`](apps/desktop/src/main/services/settings.ts) stays as defensive code (comment
generalized — no string[] setting ships today). Tests: removed `filing-suggestions.test.ts`,
`filing-suggestions-ipc.test.ts`, the db-settings string[] case, the 4 DocumentsScreen suggestion
cases, the GermanSmoke suggestion-chip case, and the audit-ipc FOLDER_SENTINEL; **added** a
no-suggestion-renders guard + a `copy-tone` stale-phrase guard (EN+DE "Suggested project"/
„Vorgeschlagenes…"). **(B) Sub-nav (`SectionRail`) regrouped + densified + collapsible.** Was
~14 near-equal items; now four headed groups in order — **All documents** (default landing, no
header, slightly-emphasized active fill) · **Projects** (header + "+", per-project "⋯") ·
**Locations** (Library/Temporary/Generated/Archived under ONE header — presentation only, data
model untouched) · **Views** (common filters Recently added/Unfiled/Needs re-index always
visible; rare diagnostics Large files/Failed imports/Audio/Scanned-OCR behind a remembered
**"More ▾"** disclosure [real `<button aria-expanded>`], and an empty rare view hidden entirely).
Nav rows densified to ~36px, uniform hover; **active = `--row-selected-bg` fill + `aria-current`,
not a ring**. The **whole panel collapses** ("«" hides → list full-width; "»" re-opens),
remembered in localStorage (`hilbertraum.docs.railCollapsed`/`…viewsMoreOpen`), mirroring the
chat `ConversationList` collapse. New i18n keys `docs.section.locations`/`docs.smart.more`/
`docs.rail.hide`/`docs.rail.show` (EN+DE, type-enforced parity; German „Speicherorte"/„Mehr"/
„Bereiche aus-/einblenden"). **RESOLVES the standing "sub-nav vs global-rail stacking" watch
item** — the second column is now dismissable, not permanent. **Tests:** typecheck + `npm run
build` clean; full vitest from `apps/desktop` **1344 passed / 25 skipped**. Playwright `_electron`
eyeball walk in BOTH themes AND both locales (EN/DE): no suggestion banner; the regrouped sub-nav
with "More" collapsed + expanded; the sub-nav collapsed (full-width) + expanded; active fill;
German labels fit without hyphenation/overflow — captures in `docs/design-review/docs-subnav/`
(`scripts/walk-docs-subnav.mjs`). **Watch item still open:** the **location-taxonomy** ambiguity
(Library/Temporary/Generated/Archived mix collection membership / lifecycle / origin) — now
grouped under one "Locations" header as PRESENTATION ONLY; the data model still needs a future
pass to decide exclusive-locations vs additive-flags. **No version bump, no schema change. Next:**
open work unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documents-screen UI refinement — follow-up pass (renderer-only,
presentation only).** Four visual fixes after the compact-row restructure shipped; **no IPC,
schema, persistence, or main-process changes**, document-task handlers untouched. Folded into
[`design-guidelines.md`](docs/design-guidelines.md) **§11.6** (the same design record the prior
pass added — extended, §-anchor stable). **What changed:** (1) **Right-aligned trailing cluster
+ reading column** — chips/badges/Preview/"⋯" wrapped in one `.doc-row-trailing`
(`flex-shrink:0`, right-aligned) next to the flex-filling `.doc-row-main` (`flex:1;min-width:0`),
so filenames use the available width and ellipsize only when truly long while Preview/"⋯" align in
a clean column down the list; the list is capped to a ~1000px reading column (`.doc-list`) and the
**Documents screen widened past the 860px `.screen` prose cap** (`.docs-screen{max-width:1180px}`,
left-aligned, not centred — a list needs more width than a reading column), with
`.docs-main{min-width:0}` as the grid-blowout guard so a long unbreakable name ellipsizes instead
of pushing the trailing actions off the edge. (2) **Tags read as tags** — row Chips restyled
(`.doc-row-chips .chip`) to a quiet filled `--surface-hover` neutral, no hard border, `--text-xs`
`--text-muted`, clearly distinct from the bordered Secondary Preview button (≥4.6:1 both themes).
(3) **Status hierarchy — one green, the rest neutral** — only the readiness badge stays green
(`success`); **Summary** and **Deeply indexed** demoted to `neutral` capability badges, each with
its own glyph (`≡`/`▦`), separating "is it ready" from "what's been done to it"; exactly one
`pill-success` per row, all icon+word (1.4.1). (4) **"⋯" overflow** confirmed present,
keyboard-focusable/tabbable (hover-revealed but never out of tab order), `aria-label` "More actions
for <filename>", full secondary set incl. the separated danger **Delete → `ConfirmDialog`** — no
regression. **Files:** `renderer/screens/DocumentsScreen.tsx` (trailing-cluster wrap, reading-column
wrap, badge tones/glyphs), `renderer/styles.css` (`.doc-list`, `.doc-row-trailing`, `.docs-screen`/
`.docs-main` width + min-width, quiet `.doc-row-chips .chip`). **No i18n/string changes** (badge
glyphs are decorative; copy-tone guard green). **Tests:** typecheck + `npm run build` clean; full
vitest from `apps/desktop` **1357 passed / 25 skipped** (+4 in `DocumentsScreen.test.tsx`:
flex-fill name + right-aligned cluster order, quiet-chip-distinct-from-Preview, one-green status
hierarchy [Ready `pill-success` vs Summary/Deeply-indexed `pill-neutral`], "⋯" keyboard-focusable).
Playwright `_electron` eyeball walk of the Documents screen in BOTH themes (a long filename
ellipsizing cleanly with room beside it, the aligned Preview/"⋯" column, quiet chips vs the Preview
button, Ready-green-only with neutral Summary/Deeply-indexed, the "⋯" menu open incl. Delete) —
before/after captures in `docs/design-review/docs-refinement/{before,after}/`. **Row-alignment and
"⋯"-reachability are now verified** (long-name breathing + aligned trailing column + keyboard-
reachable overflow). Watch items unchanged: the **location-taxonomy** ambiguity (Library/Temporary/
Generated/Archived chips over a mixed collection/lifecycle/origin model — data untouched) and the
**sub-nav vs global-rail** stacking note. **No version bump, no schema change. Next:** open work
unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documents-screen UI refinement (renderer-only; extends the Phase
23–27 wave).** A presentation-only pass on the Documents screen — **no IPC, schema, persistence,
or main-process changes**; every document task keeps its existing handler/IPC. Folded into
[`design-guidelines.md`](docs/design-guidelines.md) **§11.6** (the design record; code/i18n
comments cite it). **What changed:** (1) the per-card bank of 6–7 equal-weight buttons collapsed
to **one inline Preview (Secondary) + a "⋯" Radix `DropdownMenu` overflow** (Summarize/again,
Translate, Re-index, Build deep index [hidden once deeply indexed], Make searchable (OCR) for
scans, Add to project…, Export for generated docs, and a separated **danger Delete** behind the
existing `ConfirmDialog`) — mirrors the chat `ConversationList` ⋯ pattern; trigger `aria-label`
"More actions for <filename>", keyboard-tabbable, right-click opens it too. (2) **All state reads
as Badges** (icon + word, never buttons): one processing/ready status badge + small **Summary**
(neutral) and **Deeply indexed** (success) badges in one right-aligned cluster — the green "✓
Deeply indexed" *button* and the scattered "Summary ✓" meta + blue "Temporary" badge are gone.
(3) **Library/Temporary/Generated/Archived + project tags all render as the SAME neutral `Chip`**,
grouped, separate from the status badges. (4) **Tall cards → compact list rows** (≥40px, ~56px;
ellipsized filename + muted `--text-xs` meta "PDF · 2.0 KB · 7 sections"); hover highlight +
right-click menu; **selected rows reuse the nav/history selection treatment** — new role tokens
**`--row-selected-bg`** fill + **`--row-selected-bar`** accent left bar (per theme, ramp-reused),
not an outline ring. ~3× more docs per screen. (5) **`friendlyMimeLabel`** (pure, exported,
display-only — stored MIME unchanged) maps "application/pdf"→"PDF" etc. (6) **A non-stacking
sticky selection toolbar** (Ask these documents · Compare (2), enabled only at exactly two ·
Add to project… · mark Temporary/Archived · Delete behind `ConfirmDialog`) carries the
multi-document ops so rows stay minimal. (7) **Refresh → quiet icon button** (new `refresh` glyph
in `Icon`); Import files (Primary) + Import folder (Secondary) carry the toolbar. **Files:**
`renderer/screens/DocumentsScreen.tsx`, `renderer/components/Icon.tsx`, `renderer/tokens.css`,
`renderer/styles.css`, `shared/i18n/{en,de}.ts` (+`docs.moreActions`/`chip.generated`/
`chip.archived`/`meta.sectionsCount`/`bulk.delete*`/`selectionAria`, EN/DE parity, D-L7 informal
„du"). **Tests:** typecheck + `npm run build` clean; full vitest from `apps/desktop` **1353
passed / 25 skipped** (+5; updated the Summary/Translate/Compare/Coverage/GermanSmoke +
DocumentsScreen suites off the old button set / equal-weight Delete / "Deeply indexed" button /
blue "Temporary" badge / raw "application/pdf"; added overflow-exposes-actions, MIME-helper,
selection-toolbar + Compare-at-exactly-two, and status-as-Badge cases). Playwright `_electron`
eyeball walk of the Documents screen in BOTH themes (empty, populated, "⋯" open, Summary +
Deeply-indexed badges, Temporary/Generated/Archived chips, selection toolbar with two selected →
Compare enabled). **Risks / watch items:** (a) **Location taxonomy ambiguity** — Library /
Temporary / Generated / Archived are rendered as additive chips, but the data model mixes
collection memberships (library/temporary/project) with a lifecycle enum (permanent/temporary/
archived) and `origin` (generated); whether these are meant to be mutually-exclusive *locations*
vs additive *flags* is unresolved. The UI was made consistent (uniform chips) **without** touching
the data — a future pass should decide the taxonomy. (b) **Sub-nav vs global-rail stacking** —
checked: the 80px compact global rail + the 200px Documents sub-nav (`.docs-rail`) is one icon
rail + a 200px filter column (it collapses to a horizontal strip ≤760px), NOT the two-fat-columns
problem the chat refinement fixed; no redesign this pass, flagged only as a watch item. **No
version bump, no schema change. Next:** open work unchanged (Phase 30 big-slot/embeddings —
D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Bugfix: translation import failed with `Embedding request failed:
HTTP 500` (beta-tester report).** Symptom: translating a document ran to completion, then the
materialized output failed to import with `Embedding request failed: HTTP 500`
([`e5.ts`](apps/desktop/src/main/services/embeddings/e5.ts)), surfaced to the user as "The task could
not be finished. Make sure the model is still running." **Root cause (same class as the 0.1.20 HTTP 400
fix, but in the embedder):** the chunker now sizes chunks by space-aware `approxTokenCount` (~500), but
`E5Embedder.truncateForContext` still truncated each chunk by a **naive whitespace-word split** at an
**English-calibrated 1.4 tokens/word** (`maxInputWords = floor(512/1.4) ≈ 365`). The embedder is the
**multilingual** E5 and the translation target was **German**, which is subword-heavy at ~2 real BPE
tokens/word (see [`translation.ts`](apps/desktop/src/main/services/doctasks/translation.ts) output-token
note) — so 365 German words ≈ 730 real tokens, well over the sidecar's `--ctx-size 512`
([`sidecar.ts`](apps/desktop/src/main/services/runtime/sidecar.ts)), and llama-server's embeddings
endpoint returns **HTTP 500** for an over-context sequence (chat returns 400; embeddings 500). Space-less
scripts (CJK/Thai — the whole-word-collapse case) had the same exposure. **Fix:** `truncateForContext`
now reuses the chunker's space-aware **`truncateToApproxTokens`** and budgets against the context with a
conservative **real-BPE safety factor `REAL_TOKENS_PER_APPROX_TOKEN = 2.2`** (→ ~232 approx tokens →
~464 real worst-case German, ~50-token headroom for BOS/EOS + slop). The vector still covers the chunk's
head (adjacent chunks overlap by ~80 tokens), so retrieval is unaffected in practice. **Tests:** typecheck
clean, `npm test` **1348 passed / 25 skipped** (+2 in
[`e5-embedder.test.ts`](apps/desktop/tests/integration/e5-embedder.test.ts): the existing truncation test
now asserts `approxTokenCount(sent) ≤ floor(512/2.2)`; a new regression embeds a glued space-less run + a
2000-char CJK run and asserts both are truncated within the approx-token budget — i.e. can't overflow the
sidecar). **Docs:** [`known-limitations.md`](docs/known-limitations.md) token-budgeting bullet gained the
embedder-side NB. No version bump, no schema change. **Documents embedded before this fix are unaffected
(their vectors already persisted); the bug only ever blocked NEW imports of subword-heavy/space-less
text.** **Next:** open work unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase
E.2)._

_(prior) 2026-06-15 — **Document-summary preview UI fixes (3 reported bugs).** The summary in
the document preview modal ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)
`PreviewModal`) had three frontend problems, all fixed. **(1) Layout/scroll:** the summary `<details>`
block sat ABOVE the single `.modal-body` scroll region, so a long summary grew past the dialog's
`max-height` with no scrollbar — it's now moved INSIDE `.modal-body` (summary + extracted text share one
scroll region) and `.modal-body` got `flex: 1 1 auto` so it absorbs the leftover height ([`styles.css`](apps/desktop/src/renderer/styles.css)).
**(2) Copy + Save:** the summary action row now always offers **Copy** (→ `window.api.copyToClipboard`,
the MAIN clipboard bridge) and **Save** (→ new `exportSummary` IPC: dialog + fs in MAIN, writes the
summary as Markdown, audited as `summary_exported` with id-only metadata — the exportDocument pattern),
alongside the existing Regenerate. **(3) Markdown:** the summary rendered as raw text (literal `**`); it
now reuses the chat `AssistantMarkdown` (react-markdown + GFM, http(s)-only link sanitizer) under the
`.msg-content.md` styles. New i18n keys (`docs.previewModal.copy/save/copied/copyFailed/savedTo`,
`main.dialog.exportSummary`, `diag.audit.summary_exported`) in both en/de; new `summary_exported`
AuditEventType. Typecheck clean; `npm test` **1346 passed** + 1 new DocumentSummary case (Markdown render
+ Copy/Save bridge calls). No schema change. **Next:** open work unchanged (Phase 30
big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documentation + code-comment audit (release 0.1.26).** A deep,
whole-repo doc audit: every doc cross-checked against the code, plus a comment-quality sweep. No
behavior change — docs/comments only (the 8 touched source files are comment-only edits; typecheck
clean, `npm test` **1346 passed / 25 skipped**, unchanged from baseline). **Most consequential fixes
(security/privacy honesty):** `SECURITY.md` said the diagnostics log is "not encrypted" — it **is**
(`app.log.enc` under the vault key); the "Phase 9" stamp was refreshed with the controls added since
(deny-by-default permission handler, v2 vault envelope/O(1) password change, audit log, malicious-doc
caps, fail-closed packaged policy). `PRIVACY.md` contradicted itself on the network default (one line
"on by default", another "off") — `allowNetwork` is **ON by default** (policy-gated); also completed
the vault-descriptor description (verifier + wrapped data key). `security-model.md` + `downloads.ts`
comments corrected the same default-OFF→ON error. **Systemic fixes:** the deleted plan files
(`whole-document-analysis-plan`, `document-organization-plan`) left ~80 inline `plan §x` comments —
rather than churn them against the repo's "resolve via git history" convention, **completed the
`rag-design.md` §14 anchor-mapping table** (added §3.2/§3.3/§4.4/§5.1/§5.2) so they all resolve, and
fixed only the genuinely-misleading "Phase N = future / later phases / NULL until Phase 4" status
comments (`collections.ts`, `doctasks/manager.ts`, `db.ts`, `tree-build.ts`, `node-vectors.ts`,
`coverage.ts`, `CoverageMeter.tsx`); also dropped the false "`summary_cache` pruned by size/age"
claim. **`architecture.md` was a feature-wave behind** — added the whole-document-analysis subsystem
(`services/analysis/`, the `tree`/`extract` task kinds, 4 DB tables, the yielding `ModelSlotArbiter`
concurrency model), the whisper.cpp sidecar, the ~35-service overview, the full table list,
`analysis:`/`chat:scope` IPC, audio/image parsers, and corrected `CollectionService` (nonexistent) →
`collections.ts`. **`user-guide.md`:** moved the Local indicator off the (removed) sidebar to the chat
header (2 places); documented deep index/coverage/tiers, drag-drop into chat, the composite source
picker, filing-suggestion new-project variant, the missing model/document statuses; replaced the
hardcoded thinking-mode model list with the manifest-driven rule; corrected the network-default copy.
**model/benchmark docs:** recommendation engine corrected to RAM-best-fit (`recommendModelIdByRam`)
with the real-hardware matrix; Whisper added to the catalog + license line; E5 size 0.24→0.25;
Ministral band aligned to 16–24 GB. **Decision-number collision:** the open `big-slot-embeddings-plan`
used D23–D28 (colliding with the document-task wave's D23–D37) — renumbered to **D38–D43** and updated
all cross-refs. **rag-design body:** removed the nonexistent `TREE_GROUP_TOKENS`; corrected the
`assertChatStreamReady`/`acquireChatSlot` attribution, `buildScopeFilter` signature, `summary_cache`
column list, node-count estimate, and the compound `idx_tree_edges_child`. **Smaller:**
`known-limitations.md` (removed a misplaced "DONE" item, added the 5000-row audit cap, fixed the
`ready`/`not_recommended` claim, noted symmetric truncation), `troubleshooting.md` (`.jpeg`,
mock-runtime conditions, error-string heading), `design-guidelines.md` (D-L7 done, Phase-27 superseded
note, contrast resolved, removed nonexistent "Reading your documents" copy), `packaging.md` (aria2c
scope, Node-version guard, copy glob), `CONTRIBUTING`/`README`/`CLAUDE` (typecheck + Node in dev setup,
dead plan path, Ministral-vs-4B default, `package:win`, "llama.cpp later"→done). **Version** bumped
0.1.24 → 0.1.25 → **0.1.26** (audit merged to master at v0.1.25, then a release-version increment to
v0.1.26). No schema change. **Next:** open work is unchanged (Phase 30
big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2). (Version 0.1.25 was tagged on the
audit commit; this release-version increment to 0.1.26 supersedes it as the current release.)_

_(prior) 2026-06-15 — **Whole-document analysis — second-pass review follow-up (2 fixes).** A
high-effort re-review of the closeout diff surfaced two honesty gaps the first pass left, both now fixed in
[`manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts). **(1) Mode-(b) belt parity:**
`runCompareSectionMatched`'s reduce-input belt was structurally identical to the one M-1 fixed in mode (c)
but still returned only `plan.truncated` (the map-ceiling flag) — so a model that overruns `maxTokens`
could silently condense the asymmetric report with no notice. It now returns `plan.truncated ||
beltTruncated`; the belt cuts the later doc-A windows, so the existing `compareTruncationNotice` ("covers
its beginning") wording is accurate. **(2) Symmetric loss is now mirror-even:** the Only-A/Only-B notes in
`runCompareSymmetricTrees` are **interleaved** (A, B, A, B …) before the belt instead of appended all-A-
then-all-B, so a tail-truncating reduce sheds both documents' unique content roughly evenly — preserving
the mirror property under truncation (swapping A/B drops the same sections, off by ≤1 note at an odd
boundary) rather than always sacrificing the Only-B tail. Folded into
[`rag-design.md`](docs/rag-design.md) §14.6. **Tests:** typecheck clean, `whole-doc-compare` suite 6/6
green (the M-1 truncation test still passes; the alignNodes mirror unit tests are unaffected — the
interleave is manager-level, the pure function is unchanged). No version bump, no schema change. Feature
remains COMPLETE._

_(prior) 2026-06-15 — **Whole-document analysis — post-merge code review closeout.** Reviewed the
full wave diff (`6c27cef..f3ae4e4`) against the seven priority areas (shared-connection transactions,
the arbiter handshake, H5 staleness, mirror symmetry, grounding honesty, offline/no-leak, compare cost).
**No High/Critical findings** — the concurrency machinery, transaction discipline, and the
H5/M2/M13/mirror invariants all held. **Fixed (M-1, Medium — honesty):** a *lopsided* symmetric compare
(few aligned sections but many free Only-A/Only-B notes, e.g. A=3 vs B=40 — admitted by the min-section
gate) could let the reduce-input belt condense the note tail (Only-B notes are last) and silently
under-report B, with **no** truncation notice — exactly the H8 failure mode the asymmetric label exists to
prevent. `runCompareSymmetricTrees` ([`manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts))
now returns `truncated` when the belt fires, and `runCompare` materializes the new
**`compareSymmetricTruncationNotice`** ([`compare.ts`](apps/desktop/src/main/services/doctasks/compare.ts) —
document-neutral wording, NOT mode-(b)'s "beginning of A"; English literal per the existing notice
precedent, EN/DE parity untouched). **Fixed (L-3, Low — robustness):** `ensureNodeEmbeddings`
([`node-vectors.ts`](apps/desktop/src/main/services/analysis/node-vectors.ts)) now throws a clear error if
the sidecar returns a vector count ≠ the input count, instead of an opaque `encodeVector(undefined)` throw.
**Deferred (acknowledged, not fixed):** L-2 (dedup identical node summaries before the sidecar batch —
efficiency), L-4 (`nodeVectorSearch` is reserved/unused in prod — semi-global QA is §14.8-deferred), L-5
(`stampMetaEmbedder` silently no-ops on missing/malformed `tree_meta_json` — bookkeeping only; the
authoritative scoping is `tree_nodes.embedding_model_id`), L-6 (verify the embedder sidecar serializes
concurrent `embed` from the import loop — pre-existing architecture), and a naming nit ("greedy
mutual-best-match" is really greedy global-best-first). **Docs:** the M-1 fix folded into
[`rag-design.md`](docs/rag-design.md) §14.6; the spent `docs/whole-doc-analysis-review-prompt.md`
**deleted** (its own header said to). **Tests:** typecheck clean, build OK, `npm test` **1346 passed /
25 skipped** (+1: `whole-doc-compare.test.ts` "labels the symmetric report truncated when a lopsided pair
overflows the reduce budget (M-1)" — asserts the notice appears AND the symmetric path was still taken,
not the asymmetric fallback). No version bump, no schema change. **The whole-document-analysis feature
remains COMPLETE (Phases 1–4 shipped); this is the review closeout.**_

_(prior) 2026-06-15 — **Whole-document analysis — Phase 4 (symmetric compare + lazy node
embeddings) + FEATURE CLOSEOUT.** Final phase of the whole-document-analysis plan (§6 Phase 4;
mechanisms §4.3 symmetric compare, §3.1 node vectors). Completes the feature and folds the four-phase
plan into a §-record. **The point:** make a long-document comparison HONEST and mirror-symmetric, and
make node vectors (stored NULL since Phase 1 — L6) earn their keep as their first and only consumer.
**(1) Lazy node embeddings + node-cosine helper** (new
[`services/analysis/node-vectors.ts`](apps/desktop/src/main/services/analysis/node-vectors.ts)):
`ensureNodeEmbeddings(db, documentId, embedder)` embeds each tree node's `summary_text` on the **CPU
embedder sidecar** (`--device none`, NOT the chat slot) in one batch, reusing the exact `encodeVector`
LE-Float32 encoding, stores the blob in `tree_nodes.embedding_blob`/`dimensions`/`embedding_model_id`,
and writes it back to `summary_cache` so a **rebuild refills from the cache** (0 sidecar calls — the
rebuild mints fresh NULL-vector rows with the same `content_hash`). **Scoped by `embedding_model_id`
[H5]:** a node under a different embedder (mock↔real / model swap) is **re-embedded** under the active
one — a mixed-embedder alignment NEVER silently happens; stamps `tree_meta_json.embeddingModelId`.
`nodeVectorSearch`/`loadNodeVectors` read **only `tree_nodes`** (never the chunk `embeddings` table —
node vectors stay out of citation-grade chunk retrieval, §3.6); they are NOT `VectorIndex` [H4].
**(2) Pure alignment** ([`doctasks/compare.ts`](apps/desktop/src/main/services/doctasks/compare.ts)):
`alignNodes(a, b)` — **greedy mutual-best-match** by node-vector cosine with a **swap-invariant**
tie-break (the canonical pair key) above `SYMMETRIC_MATCH_MIN_SCORE` (0.5) → pairs + unmatched-A +
unmatched-B; pure ⇒ the **mirror property** (swap A/B ⇒ Only-A ↔ Only-B, Same/Different stable) is
unit-tested without the model [M11]. Plus `compareNodePairPrompt` (equal-footing diff),
`comparePairOutputCap`, `compareAsymmetricNotice`, `SYMMETRIC_COMPARE_CALL_CEILING` (24).
**(3) Symmetric compare** ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)):
`runCompare` now picks a mode — **(a)** single-pass (already symmetric, unchanged); **(c)
`runCompareSymmetricTrees`** when BOTH docs have a `ready` tree under the active embedder AND the smaller
has ≤ ceiling level-1 sections (`bothTreesReadyForSymmetric`): lazily embed both trees' nodes, align
level-1 sections, diff each pair with one `generate`, attribute unmatched sections to Only-A/Only-B with
NO model call (node summaries fed as notes — M2, never `[Sn]` citations), reduce into the four-section
report; **(b)** the existing A-driven section-matched map-reduce as the LABELLED asymmetric fallback
(`compareAsymmetricNotice` materialized into the report when the two docs aren't both deeply indexed —
H8). The node-embed pass runs INSIDE the (non-yielding) compare DocTask, so it's still one model job at
a time (chat is refused during compare). **Data contracts (now real):** `tree_nodes.embedding_blob`/
`dimensions`/`embedding_model_id` columns are POPULATED (were NULL since Phase 1); `tree_meta_json.
embeddingModelId` records the active embedder for the staleness guard; the node-cosine helper + the
symmetric compare strategy + the embedder-staleness re-embed are the new machinery.
**Decisions flagged (not silently made):** (a) **lazy-embed on first compare**, not an explicit
"prepare compare" action (Q-default); (b) **fall back to the labelled asymmetric mode (b)** when a tree
is missing, offering the existing per-doc "Build deep index" action rather than auto-building or
requiring it (Q4-default); (c) the node-embed pass is **folded into `runCompare`**, NOT its own
DocTaskKind (it's a sidecar embed, not a chat-slot job; the compare task already serializes). The compare
in-document notices stay **English literals** (the existing `compareTruncationNotice`/`compareAttributionLine`
precedent — the report body itself is in the documents' language; a D-L7 candidate, NOT a new i18n key,
so EN/DE parity is untouched). **NOT built (deferred):** the collection "tree of trees"; a live full-scan
for unmapped extract types; semi-global QA (node summaries as derived context); node vectors in chunk
retrieval/citations; a symmetric compare above the 24-section ceiling (→ labelled asymmetric). **Tests:**
typecheck clean, build OK, `npm test` **1345 passed / 25 skipped** (+12: unit
[`node-align.test.ts`](apps/desktop/tests/unit/node-align.test.ts) — alignNodes identical→pair/orthogonal→
unmatched, the **mirror** property incl. tied scores [swap-invariant tie-break], match-floor + dim-mismatch
skip, `comparePairOutputCap` bounds; integration
[`whole-doc-compare.test.ts`](apps/desktop/tests/integration/whole-doc-compare.test.ts) — symmetric path
taken + node vectors populated under the active embedder = node count, second compare reuses [0 extra
node-embeds], rebuild refills from `summary_cache` [0 sidecar], H5 re-embed under a NEW embedder [never a
silent empty align], labelled asymmetric fallback reached only without both trees, node vectors persist +
decode after a DB reopen [whole-file-encrypted round-trip]). No version bump, no schema change (Phase 1's
nullable node-vector columns suffice). **FEATURE CLOSEOUT (doc-lifecycle):** the whole four-phase
`docs/whole-document-analysis-plan.md` is condensed into **[`docs/rag-design.md`](docs/rag-design.md) §14
(analysis design record, §14.1–§14.8)** and the plan file is **deleted** (full original incl. all three
audit passes: `git show 4071685:docs/whole-document-analysis-plan.md`). §14.x anchors are stable; the two
in-code "plan §x" path pointers ([`db.ts`](apps/desktop/src/main/services/db.ts) → §14.2,
[`whole-doc-analysis.test.ts`](apps/desktop/tests/integration/whole-doc-analysis.test.ts) → §14.1–§14.3)
are repointed (inline "plan §x" comments resolve via git history, per the doc-org precedent);
[`known-limitations.md`](docs/known-limitations.md) compare entry updated (symmetric-when-both-deeply-
indexed, else labelled one-directional). **Risks / next:** the symmetric path is O(sections) `generate`
calls (bounded by the 24-section ceiling → labelled asymmetric above it) — a heavy but user-initiated
background task on weak CPUs; the mock embedder is structure-only so semantic diff quality is a manual/
PAID smoke, not the mock suite. **The whole-document-analysis feature is COMPLETE (Phases 1–4 shipped).**_

_(prior) 2026-06-15 — **Whole-document analysis — Phase 3 (structured extract-then-aggregate).**
Third phase of [`docs/whole-document-analysis-plan.md`](docs/whole-document-analysis-plan.md) (§6 Phase 3;
mechanisms §3.3 schema, §4.2 extract+aggregate, §4.4 router, §5.1 IPC). Moves "list every X / how many"
off top-k relevance and onto a precomputed, provenance-backed SQL aggregation answered at **zero
query-time model calls** — exhaustive OVER INDEXED SECTIONS, never "complete" [H7]. **(1) Schema**
([`db.ts`](apps/desktop/src/main/services/db.ts)): additive `extraction_records` table (one item row per
surfaced item + one `__scan__` marker row/chunk recording `ok`/`unparsed`; `chunk_id` **FK ON DELETE
CASCADE** ⇒ re-index self-invalidates [H1 free win, under `PRAGMA foreign_keys = ON`]) + `idx_extract_doc_type`/
`idx_extract_chunk`; `documents.extract_status` column via `ensureColumn` (NULL|pending|extracting|ready|stale|
failed, mirrors `tree_status`); `reconcileStuckExtracts` (mirror of `reconcileStuckTrees`, `extracting`→
`pending`); re-index resets `extract_status`→`stale` in the chunk-replacement block (rows cascade away).
**(2) Extract pass** (new [`services/analysis/extract.ts`](apps/desktop/src/main/services/analysis/extract.ts)):
`extractDocument` — the second YIELDING build (same arbiter handshake/park/cancel/lock discipline as the
tree, [H3/H9/H10]); one `generate`/chunk over the fixed v1 type set (`generic|date|amount|party|obligation`),
strict JSON-array prompt at temp 0, tolerant `parseExtraction` (recovers fenced/prose-wrapped arrays;
`[]` is a valid empty parse) + **retry-once**, then an `unparsed` `__scan__` marker — **never drops the
chunk** [H7]; per-`(chunk_id, content_hash)` **resume cache** = **0** calls on re-run; per-chunk
`try{BEGIN…COMMIT}catch{ROLLBACK}` [H11]; `normalized_value` dedup; node vectors out of scope.
`aggregateExtractions` — query-time GROUP BY `normalized_value` through the shared
`buildScopeFilter('document_id')` [M3], **0** model calls, returns items+counts+source-chunk provenance +
`scannedChunks`/`totalChunks`/`unparsedChunks`/`fullyChunked`. **(3) DocTaskManager**
([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)): new `extract` `DocTaskKind`
+ `runExtract` (registers/unregisters the arbiter like `runTreeBuild`), validated like `tree` (one doc,
runtime required, **`fully_chunked` gate [C4]**); `isYieldingKind` makes `abortActiveBuild`/`cancelDocTask`
arbiter-reject treat extract like tree (chat-stream's pause-vs-refuse already keys off the arbiter).
**(4) Router** (new [`services/analysis/router.ts`](apps/desktop/src/main/services/analysis/router.ts),
pure): `routeQuestion` — EN+DE classification (list/every/each/how many/count + jede/alle/wie viele/
sämtliche/liste/zähl), fixed precedence **explicit-button > compare(2 docs) > coverage-extract >
tree-summary > relevance** [M7], closed-vocab→type synonym map (`mapQuestionToRecordType`, EN+DE, default
generic), **low-confidence / no-extract-data / compare-without-2-docs → labelled relevance** (never an
empty "no items" or a false "complete"). **(5) rag:ask wiring**
([`registerRagIpc.ts`](apps/desktop/src/main/ipc/registerRagIpc.ts)): after scope resolve + filename
auto-scope, a `coverage-extract` decision over a mapped pre-extracted type streams the deterministic
listing (new [`services/analysis/listing-answer.ts`](apps/desktop/src/main/services/analysis/listing-answer.ts)
— coverage line + per-item provenance + caveat, built via `tMain`) at 0 model calls; **everything else
falls through to the existing relevance path byte-unchanged**. **(6) IPC**: `analysis:listAll`
([`registerDocTasksIpc.ts`](apps/desktop/src/main/ipc/registerDocTasksIpc.ts)) → `ExtractionListing|null`
(read-only, content stays in DB); mirrored in [`preload`](apps/desktop/src/preload/index.ts); channel in
[`shared/ipc.ts`](apps/desktop/src/shared/ipc.ts). **(7) Shared contracts**
([`shared/types.ts`](apps/desktop/src/shared/types.ts)): `ExtractRecordType`/`EXTRACT_RECORD_TYPES`,
`ExtractStatus`, `ExtractionListing`/`ExtractionListingItem`/`ExtractionListingRequest`; `DocTaskKind +=
'extract'`; `CoverageMode += 'extract'` + `CoverageInfo.unparsedChunks`/`fullyChunked` (the reserved Phase-2
field, now real); `DocumentInfo.extractStatus` (threaded via `DocumentRow`/`rowToInfo`). **(8) Renderer**:
`CoverageMeter` ([`CoverageMeter.tsx`](apps/desktop/src/renderer/components/CoverageMeter.tsx)) gains the
`extract` listing copy ("every match … N sections scanned (k unparsed)", whole-document wording gated on
`fullyChunked`, NEVER "complete"). **i18n**: EN+DE `analysis.kind.*`/`analysis.listing.*`/`coverage.extract.*`/
`docs.task.extract*` (type-enforced parity; forbidden-UI-words honoured — "sections", no chunk/record/extract
jargon; German flagged **D-L7**). **Decisions flagged (not silently made):** (a) extract is **manual-only**
(started via `startDocTask`), NOT auto-enqueued at import — avoids surprise multi-minute CPU spend (Q4
default); (b) a **separate `extract_status` column** (NOT folded into a shared `deep_index_status`) — tree +
extract run independently; (c) an unmapped/ad-hoc "{X}" falls back to **labelled relevance** in v1 (no live
full-scan task — deferred), so the 0-call completeness claim is only ever made for a mapped pre-extracted
type. The chat listing surfaces its honesty IN-TEXT (coverage line + caveat) rather than threading a new
per-message `CoverageInfo` payload (avoids a `messages`-table change); the `extract` CoverageMeter mode is
wired for the meter component + future preview use. **NOT built (Phase 4):** symmetric/both-trees compare,
node-vector align, node embeddings (node vectors stay NULL — L6); the collection "tree of trees"; a live
full-scan for unmapped types. **Tests:** typecheck clean, build OK, `npm test` **1333 passed / 25 skipped**
(+27: unit [`extract-router.test.ts`](apps/desktop/tests/unit/extract-router.test.ts) — router classification/
precedence/low-confidence→relevance/open-vocab→type EN+DE + `parseExtraction` JSON tolerance/empty-vs-unparsed/
unknown-type-coerce; integration [`whole-doc-extract.test.ts`](apps/desktop/tests/integration/whole-doc-extract.test.ts)
— O(n) calls + per-chunk markers, unparsed marker [H7], warm-cache re-run = 0 calls, per-chunk ROLLBACK +
connection-survives + resumable [H11], aggregation GROUP BY via buildScopeFilter = 0 calls + ground-truth
count + per-item provenance, archived-excluded [M3], re-index cascade→stale [H1], honest listing answer
"sections scanned"+caveat + unparsed surfaced; renderer [`Coverage.test.tsx`](apps/desktop/tests/renderer/Coverage.test.tsx)
— extract meter whole-vs-sections + unparsed, never "complete"; +1 GermanSmoke extract meter). No version
bump, no schema-version (additive table/column). **Risks / next:** the extract pass is a multi-minute
serialized CPU pass on weak hardware (manual, size-unbounded — a UI trigger + size gate like the deep index
is a follow-up); per-chunk recall/dedup/overlap caveats are surfaced, not solved (the H7 honesty point);
**Next:** Phase 4 — symmetric, coverage-oriented compare + lazy node embeddings._

_(prior) 2026-06-15 — **Whole-document analysis — Phase 2 (coverage meter + tiers +
provenance UI).** Second phase of [`docs/whole-document-analysis-plan.md`](docs/whole-document-analysis-plan.md)
(§6 Phase 2; mechanisms §4.5 coverage tiers, §5.1 IPC + `CoverageInfo`, §5.2 renderer). The
honesty layer over Phase 1's deep index: surface BREADTH (whole document vs the most relevant
passages) and DEPTH (tier) as two separate, honest statements — **breadth ≠ fidelity [C1/L2]**,
"100%"/"deeply indexed" shown ONLY for a `ready` tree, and node summaries are NEVER `[Sn]`
citations [M2]. **(1) Shared contracts** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)):
new `CoverageInfo` (`mode:'tree'|'relevance'|'capped'`, `treeStatus?`, `chunksCovered/Total`,
`treeLevels?`, `tier?`, `truncated?`; `unparsedChunks` reserved for Phase 3), `DocumentCoverage`
(`{coverage, provenance: Citation[]}`), `TreeBuildStatus`, `CoverageTier`; `DocumentSummary.tier?`;
`DocumentInfo.treeStatus`/`fullyChunked`/`treeLevels` (additive/optional, threaded via
`DocumentRow`/`rowToInfo`/`listDocuments`/`getDocument` in
[`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts); `parseSummary` now keeps
`tier`). **(2) Coverage + provenance reader** (new
[`services/analysis/coverage.ts`](apps/desktop/src/main/services/analysis/coverage.ts)):
`reachableLeafChunkIds` (the PRODUCTION `tree_edges`→leaf-chunk walk, replacing Phase 1's test-only
helper), `documentLeafProvenance` (leaf SOURCE chunks → `Citation[]`, M2-safe), `documentCoverage`
(breadth+depth — ready ⇒ whole-document at tier; building/stale/pending ⇒ partial fraction, never
100%; no tree ⇒ capped/beginning), plus `maxTreeLevel`/`nodeSummariesAtLevel` for the tiers. Pure DB
reads, no model call; all CONTENT-derived (never logged/audited). **(3) Coverage tiers** in
`runSummary` ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts) new
`summarizeFromTree`): requested via the `summary` task `params.tier` (no-arg = **Tier 1**, so the
one-click summary is byte-unchanged) — **Tier 1** = stored root verbatim (**0** model calls, Q6);
**Tier 2** = ONE reduce over the root's children (the layer that fit the root's single budget group,
so always one window); **Tier 3** = ALL level-1 nodes reduced in budget batches **bounded by node
count**, never document size. All tiers cover the whole document (`truncated:false`). **(4) IPC**:
`analysis:coverage(documentId)` ([`registerDocTasksIpc.ts`](apps/desktop/src/main/ipc/registerDocTasksIpc.ts))
→ `DocumentCoverage|null` (read-only; provenance only for a `ready`-tree summary); mirrored in
[`preload`](apps/desktop/src/preload/index.ts); channel in
[`shared/ipc.ts`](apps/desktop/src/shared/ipc.ts). **(5) Renderer**: new
[`components/CoverageMeter.tsx`](apps/desktop/src/renderer/components/CoverageMeter.tsx) — `CoverageMeter`
(breadth pill + depth line) and `TierMenu` (reusing the `DepthMenu` Radix pattern); the
PreviewModal ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)) renders
the meter (augmenting the truncated banner), the tier selector (only with a ready deep index), and
`SourcesDisclosure` provenance — fetched via `documentCoverage` on open; the chat
[`Transcript`](apps/desktop/src/renderer/chat/Transcript.tsx) labels every grounded (cited) answer
mode `relevance` ("the most relevant passages — not the whole document"); a **"Build deep index"** /
**"Re-index for deep index"** (C4) / **"Deeply indexed"** badge row action on `DocumentsScreen`
(`onBuildDeepIndex`/`onSummarizeTier`). **i18n**: new EN+DE `coverage.*` + `docs.deepIndex.*` +
`docs.previewModal.sources` (type-enforced parity; forbidden-UI-words honoured — "deeply indexed"/
"sections"/"passages", no tree/node/chunk/vector/embedding leak; German flagged for **D-L7**). **NOT
built (Phases 3–4):** `extraction_records`/`extract.ts`, the "list every X" router rule, symmetric
compare, node embeddings (node vectors stay NULL — L6). **Tests:** typecheck clean, build OK,
`npm test` **1306 passed / 25 skipped** (+22: 8 integration in
[`whole-doc-analysis.test.ts`](apps/desktop/tests/integration/whole-doc-analysis.test.ts) — ready-tree
whole-document coverage at tier, reachable-leaves==chunk-count + leaf provenance [M2], tree-less
capped truncated/whole, building reports partial-not-ready [C1], Tier 1/2/3 = 0/1/bounded calls +
absent-param-defaults-Tier-1; 10 renderer in
[`Coverage.test.tsx`](apps/desktop/tests/renderer/Coverage.test.tsx) — meter honesty [relevance label,
ready whole+tier, building never 100%, capped never complete], chat relevance label on/off, Build-deep-
index starts a `tree` task, C4 "Re-index first" re-indexes not a dead build, ready "Deeply indexed"
badge, PreviewModal meter+selector from `analysis:coverage`; +2 GermanSmoke — deep-index action +
CoverageMeter German). No version bump, no schema change (Phase 1's columns/tables suffice). **Risks /
next:** the row "Build deep index" is offered on any indexed non-generated doc without a ready tree
(user-initiated, may be a multi-minute CPU build on weak hardware); **Next:** Phase 3 —
`extraction_records`/`extract.ts` + the "list all/every/how many" router rule._

_(prior) 2026-06-15 — **Whole-document analysis — Phase 1 (cap honesty + ingest-time
summary tree).** First phase of [`docs/whole-document-analysis-plan.md`](docs/whole-document-analysis-plan.md)
(§6 Phase 1; mechanisms §3.1–§3.5, §4.1, §5.1). Moves whole-document coverage from query time
to ingest time via a persistent hierarchical summary tree (RAPTOR-lite), and makes the
1 000-chunk cap HONEST. Offline, one model job at a time, node vectors deferred (NULL) to Phase 4.
**(1) Cap honesty [C1/C2/C4/M13].** New single source of truth `MAX_CHUNKS_PER_DOCUMENT`
([`chunker.ts`](apps/desktop/src/main/services/ingestion/chunker.ts)); `processDocument`
([`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts)) now chunks with
`maxChunks = cap + 1` and **rejects an over-cap document** with a persist-canonical
`main.ingest.tooManyChunks` **BEFORE** the destructive `DELETE FROM chunks` (M13 — a re-index of
an over-cap doc keeps its existing searchable chunks; the gate fails closed), and stamps a
`documents.fully_chunked` marker at the ONE indexing-success site (every path funnels through it —
C4), so "the stored chunks ARE the whole document" is provable. A legacy `fully_chunked IS NULL`
doc must re-index before any deep index / 100 %-coverage. **(2) Schema** ([`db.ts`](apps/desktop/src/main/services/db.ts)):
additive `tree_nodes` / `tree_edges` (polymorphic `child_id`, NO FK to chunks) / `summary_cache`
tables in `SCHEMA`; `documents.tree_status` / `tree_meta_json` / `fully_chunked` columns via
`ensureColumn`; `reconcileStuckTrees` (mirror of `reconcileStuckDocuments`, flips a stuck
`building` → `pending`); **tree teardown** in the chunk-replacement block (`DELETE FROM tree_nodes`,
edges cascade via `parent_id`; `tree_status` → `stale` when a tree existed — H1/H2). Everything
inherits whole-file encryption; node summaries / cache are CONTENT (never logged/audited).
**(3) Model-slot arbiter [H9/H10/M9]** (new [`services/analysis/model-slot-arbiter.ts`](apps/desktop/src/main/services/analysis/model-slot-arbiter.ts)):
the single in-process owner of the chat runtime slot for a YIELDING build — `shouldYield`/`reacquire`
(builder PARKS, does NOT return) / `acquireForChat` (chat requests a pause, awaits the handoff,
gets a release fn) / `abort` (rejects the parked reacquire on cancel/lock/quit). **(4) Yielding
per-node build** (new [`services/analysis/tree-build.ts`](apps/desktop/src/main/services/analysis/tree-build.ts)):
packs chunks → summarizes each group into one fresh node → recurses to one root; **one
`try{BEGIN…COMMIT}catch{ROLLBACK;rethrow}` per node** (H11 — a thrown insert never poisons the
shared connection); summary text from the content cache keyed `(content_hash, model_id)` (C3 — a
rebuild/resume over a warm cache costs **0** chat calls; node identity is a fresh row per
position so boilerplate can't collapse the tree); **node vectors NULL** (L6 — embedded lazily in
Phase 4); resume = discard partial tree + rebuild from cache; model pinned via `tree_meta.modelId`
(M12). **(5) DocTaskManager** ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)):
new `tree` DocTaskKind (validates `fully_chunked`), `runTreeBuild` (registers/unregisters with the
arbiter), `isYieldingBuildActive` / `acquireChatSlot` / `abortActiveBuild`, and
`maybeEnqueueTreeBuild` (auto-offer, size-gated on `planSummaryWindows().truncated`, runtime-gated →
`pending`). `runSummary` now **serves the ready tree root verbatim** (`truncated:false`, 0 extra
calls — M1) and falls back to the capped map-reduce when there is no tree. **(6) Chat handoff**
([`chat-stream.ts`](apps/desktop/src/main/ipc/chat-stream.ts) now **async** + branches on the
running task's kind; `withChatStream` acquires the slot before any model call and releases it in
`finally`; callers `registerChatIpc`/`registerRagIpc` await it). Lock/quit
([`registerWorkspaceIpc.ts`](apps/desktop/src/main/ipc/registerWorkspaceIpc.ts), `index.ts`
`shutdown`) call `abortActiveBuild()` before the sidecar teardown (M9); `listDocuments`
([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)) reconciles stuck trees when
no task is live, and import/reindex call `maybeEnqueueTreeBuild`. **i18n:** `main.ingest.tooManyChunks`
+ `docs.task.treeBusy`/`treeBusyTitle` (EN+DE, type-enforced parity; "deep index" is the user word —
no chunk/node/tree jargon; German flagged for the standing **D-L7** review); `tooManyChunks` added
to the D-L4 display map. **Docs:** plan status banner → "Phase 1 shipped"; `known-limitations.md`
(over-cap rejection behavior change + deep-index coverage note). **NOT built (Phases 2–4):** the
coverage-meter UI, `extraction_records`/`extract.ts`, symmetric compare, node embeddings.
**Tests:** typecheck clean, build OK, `npm test` **1284 passed / 25 skipped** (+21: 6 unit
[`model-slot-arbiter.test.ts`](apps/desktop/tests/unit/model-slot-arbiter.test.ts) — pause/resume,
last-chat-resumes, abort-rejects, no-hang-on-finish, idempotent release; 15 integration
[`whole-doc-analysis.test.ts`](apps/desktop/tests/integration/whole-doc-analysis.test.ts) — over-cap
rejection + never-partial, M13 re-index-fails-closed, `fully_chunked`, structural root→every-leaf
incl. the last chunk [M11], tree-first summary [M1], tree-less fallback, warm-cache rebuild = 0
calls + re-index→stale→cache reuse despite chunk-id churn [C3/H1/H2], C4 legacy gate, H11
ROLLBACK + connection survives, H10 chat-pauses-build-resumes-in-session + cancel-rejects-parked,
DB-reopen persistence, reconcileStuckTrees). No version bump. **Risks / next:** auto-enqueue runs
a multi-minute serialized build on weak CPUs (size-gated to docs the capped summary can't cover);
the chat↔chat double-send race in the now-async guard is theoretical (UI prevents it) and can't
cause two model jobs; **Next:** Phase 2 — `CoverageInfo` + the coverage-meter/tier/provenance UI._

_(prior) 2026-06-15 — **Diagnostics copy/save + download resilience (beta-tester
feedback).** Three small improvements, rebased on top of the 0.1.21 document-organization wave.
**(1) Copy buttons** on the Settings → "Diagnostics (advanced)" cards: **App & runtime**, **Hardware
benchmark**, and **Logs** each gained a **Copy** button that writes a plain-text rendering of exactly
the rows shown to the clipboard (toast-confirmed), so a user can paste diagnostics into a support
message. The on-screen rows and the copied text share the same builders
(`runtimeStatusLine`/`buildAppRuntimeReport`/`buildBenchmarkReport` in `DiagnosticsTab.tsx`) so they
can't drift — the App-card runtime row was refactored onto `runtimeStatusLine` to dedupe. Copy goes
through a new **`window.api.copyToClipboard`** that writes from the **MAIN process** (`clipboard:write`
IPC → Electron's `clipboard.writeText`), **not** `navigator.clipboard` — the latter needs a secure
context + focused document and threw a "can't copy to clipboard" error in the `file://`-loaded
renderer (beta-tester report). **The write MUST be in main:** the renderer is `sandbox: true`, and a
sandboxed preload has no access to the `clipboard` module (only `ipcRenderer`/`contextBridge`/
`webFrame`/`nativeImage`/`webUtils`) — an initial preload-side `clipboard.writeText` silently failed
the same way until it was moved to main. The same bridge is used by the chat message-copy action. **(2) Save
logs to a file:** the Logs card gained **Save to file…** → new `exportLog` IPC (`logs:export`) →
`saveTextExport`, writing the **whole** current log (new `readLogFull()` in `logging.ts`, not just the
`getLogTail` tail) as **plaintext** to a user-chosen path. The on-disk `app.log` stays **encrypted**
at rest; the export is a deliberate user action to take a copy *outside* the vault for support (never
uploaded, no telemetry). **(3) Flaky-connection download hardening:** a beta tester's link dropped
mid-`curl` and lost the download. `curl --retry` alone doesn't retry a mid-transfer DROP on older
curl, so every `curl` in the fetch scripts now goes through a wrapper (`Invoke-CurlResilient` in
`.ps1`, `curl_resilient` in `.sh`) — an **outer retry loop** (5 attempts, growing back-off) that
**resumes the partial file** (`-C -`) each attempt, plus strengthened per-call flags (`--retry 3
--retry-delay 2 --retry-connrefused --connect-timeout 30`). SHA-256 verification AFTER download is
unchanged, so resume can't weaken integrity. **Files:** `services/logging.ts` (+`readLogFull`),
`shared/ipc.ts` (+`exportLog`, +`writeClipboard`), `ipc/registerCoreIpc.ts` (export + clipboard
handlers), `preload/index.ts` (+`exportLog`, +`copyToClipboard`),
`renderer/screens/settings/DiagnosticsTab.tsx`, `renderer/screens/ChatScreen.tsx` (main-clipboard
copy), `shared/i18n/{en,de}.ts`
(+`diag.copy*`/`diag.logs.save`/`diag.logs.savedTo`/`main.dialog.exportLog`),
`scripts/fetch-runtime.{ps1,sh}`, `scripts/fetch-models.{ps1,sh}`. Two follow-up polish passes:
benchmark-card buttons restyled to match App & runtime (small secondary, not a large primary) + 8px
gap above the results; clipboard write moved preload → main (sandbox fix). **Docs:** `architecture.md`
("Diagnostics & transcript export" copy/save bullet), `packaging.md` ("Resilient downloads" para).
**Tests:** typecheck clean, build OK, `npm test` **1263 passed / 25 skipped** (+7 over the 0.1.21
doc-org baseline: 4 renderer copy/save in `DiagnosticsCopySave.test.tsx`, +1 `readLogFull` in
`logging.test.ts`, +2 `writeClipboard` handler in `core-model-ipc.test.ts`; the copy assertions point
at the `copyToClipboard` bridge). Released as **0.1.23** (the wave's working `v0.1.22` tag was
superseded by the version bump), tagged `v0.1.23`._

_(prior) 2026-06-15 — **Merged the document-organization wave (Phases A–F) to `master`; release
0.1.21.** The whole Library/Projects/Temporary/Generated/Archive feature + its audit remediation
(DM-1/DM-2/RAG-1/SEC-1 + UX-1/UX-2/UX-3) + the D-L7 doc-org German pass are now on `master`; a focused
security review of the branch came back clean (no findings). Merged on top of `master`'s
document-analysis `HTTP 400` fix (0.1.20) — the overlapping service/i18n files auto-merged; only the two
`package.json` versions (→ 0.1.21) and this handoff narrative needed hand-resolution. Tagged `v0.1.21`.
Per-entry detail for both lines below._

_(prior) 2026-06-14 — **Bugfix: document analysis failed with `HTTP 400` on space-less
text (beta-tester report).** Symptom: every document **summary** and **document answer** failed
with `Chat request failed: HTTP 400` while plain chat worked, across two models (qwen3-4b-2507 /
4096 ctx and qwen3-8b / 8192 ctx). **Root cause:** `tokenize`/`approxTokenCount`
([`chunker.ts`](apps/desktop/src/main/services/ingestion/chunker.ts)) counted whitespace WORDS, so
text with no word breaks — CJK/Thai, or a glued PDF/extraction run — collapsed to ~1 "token". That
silently defeated every context budget (chunker, summary/translation/compare windows, the RAG cap),
so the assembled prompt overflowed the model context and llama-server returned
`exceed_context_size_error` (a 400). Reproduced + verified the fix end-to-end against the user's exact
build (b9585 `d73cd0767` on `D:`): an un-windowed space-less doc → 400, a budget-sized window → 200.
**Fixes:** (1) `approxTokenCount` now counts space-less scripts per character and charges over-long
no-space runs by length; new `windowByTokens`/`truncateToApproxTokens` do content-preserving,
budget-bounded windowing (space-less runs hard-cut by char, nothing inserted). `chunkSegments`,
`packIntoWindows` (summary+translation), `planCompareWindows`, and the manager reduce/pair clamps all
switched off raw word slicing onto these. **Normal prose is unchanged (word≈token), so existing
budget tests stayed green; documents indexed before the fix keep their old chunks until Re-indexed.**
(2) `LlamaRuntime.chatStream` now throws a typed **`ChatRequestError`** that includes the server's
`{error:{message,type}}` body (it used to be discarded); `isExceedContextError` maps the overflow to
the friendly, localized **`main.model.contextExceeded`** in the doctask manager + chat/RAG stream
wrapper. (3) Secondary latent bug fixed: a failed answer left an orphan user turn, so a later turn
sent **consecutive user messages** → some templates raise `HTTP 500` ("roles must alternate");
`collapseToAlternating` (applied in `buildChatMessages`/`buildGroundedChatMessages`) keeps strict
role alternation. **Files:** `services/ingestion/chunker.ts`, `services/doctasks/{summary,compare,
manager}.ts`, `services/runtime/llama.ts`, `services/chat.ts`, `services/rag/index.ts`,
`ipc/chat-stream.ts`, `shared/i18n/{en,de}.ts`. **Docs:** `rag-design.md` (token estimate +
windowing), `architecture.md` "Chat & streaming" (role alternation + surfaced errors),
`known-limitations.md` (token-budget bullet corrected + re-index note). **Tests:** typecheck clean,
`npm test` **1155 passed / 25 skipped** (+13: chunker space-less/windowing, summary CJK window,
llama-runtime error-body + `isExceedContextError`, `collapseToAlternating`). No version bump._

_(prior) 2026-06-14 — **D-L7 German-copy review (document-organization slice) + UX-3.**
Closing the i18n/a11y items deferred by the doc-org audit remediation. Surveyed the German catalog
against the pinned informal-„du" glossary ([`de.ts`](apps/desktop/src/shared/i18n/de.ts) header, D-L7):
the Phase D/E/F doc-org copy was clean **except** for **7 formal „Sie/Ihre" strings**, all now recast
informal — `chat.scope.sourcesTitle` („Wähle deine Quellen", **UX-2**), `chat.scope.librarySourceHint`
(„Deine gesamte Wissensbasis", **UX-2**), `chat.scope.archivedFallback`, `docs.project.deleteBody`/
`deleteKeepHint`/`deleteWithHint`, and the adjacent `docs.reindexAllConfirm.body`. (Verified the three
other `Sie/Ihr` hits at `de.ts:714/839/940` are the pronoun „it/its", not address — left as-is.) The
six `D-L7-Review ausstehend`/`…markiert` markers on the doc-org blocks (de.ts + en.ts) now read
**`erledigt (2026-06-14)`**. **UX-3 (a11y):** attachment processing/added is now announced on the
keyboard/picker path — a visually-hidden polite **`role="status"` aria-live** region in the chat surface
([`ChatScreen.tsx`](apps/desktop/src/renderer/screens/ChatScreen.tsx)) driven by a new
**`chat.attach.added`** key (EN „Added {name} to this chat" / DE „{name} zu diesem Chat hinzugefügt");
processing reuses `chat.attach.processing`; failures stay on `ErrorBanner`. en/de key parity stays
type-enforced. **Tests:** typecheck clean, **`npm test` 1243 passed / 25 skipped** (count unchanged;
`ChatAttach` "pending chip" test now asserts the text appears in BOTH the visible chip AND the sr-only
announcer — i.e. covers UX-3). No version bump. **Audit findings now fully closed:** UX-1/UX-2/UX-3 (the
last open doc-org items). Docs: `known-limitations.md` flipped the deferral note to DONE. **Next:** the
broader Phase 39–42 German sign-off (user's standing D-L7 pass) is still open; owner-gated Phase E.2; the
unremediated security audit (`docs/security-audit-2026-06-14.md`); or new work._

_(prior) 2026-06-14 — **Document-organization audit remediation** (the audit report
`docs/document-organization-audit-2026-06-14.md` was deleted once fully remediated — the final version
incl. the remediation banner is recoverable via
`git show e294377:docs/document-organization-audit-2026-06-14.md`).
Implementation pass fixing the audit's correctness bugs + adding the tests that should have caught them.
**FIXED (closed):** **DM-1 (High)** — M1 crash-resume now files by pending destination on EVERY
indexing success: `fileFromPendingDestination` is called inside
[`reindexDocument`](apps/desktop/src/main/services/ingestion/index.ts) (not only the import loop), so a
crash-interrupted Project/Temporary/conversation import that the user re-indexes lands in its intended
destination, not Library; the helper now also **skips generated docs** (`origin_json` set ⇒ never filed,
D3/N1) so re-indexing a translation can't sweep it into Library. **DM-2 (Medium)** — generated
`origin_json` is now stamped at `createQueuedDocument` time (new `origin` option) BEFORE the row can be
`indexed`, so the Library backfill's `origin_json IS NULL` guard holds across a mid-materialize crash
(`materializeDocument` passes `origin` at create; the post-success `setDocumentOrigin` only re-asserts it
+ clears `original_path`). **RAG-1 (Medium)** — `generateGroundedAnswer` now passes the same scope
retrieval used to `corpusNeedsReindex` (`normalizeScope(opts.scope ?? opts.scopeDocumentIds)`), so the
re-index-vs-empty honesty holds on the legacy doc-id path too (whole-corpus/composite paths
byte-identical). **SEC-1 (Low)** — `updateSettings` now validates array-typed defaults element-wise
(require `Array.isArray`, keep only strings, cap at 10 000) so `dismissedFilingSuggestions` can't persist
a non-array/oversized renderer value. **DM-3 (Low)** — `expandPathsWithSource` matches a picked root on a
separator boundary (`=== dir || startsWith(dir+sep)`), no sibling-prefix mislabel. **RAG-3 (Low)** — the
FTS scope predicate moved from the JOIN `ON` to `WHERE` (param order preserved; LEFT-JOIN-safe). **UX-1
(Low)** — the filing-suggestion chip is `role="group"`+`aria-labelledby` with the reason tied to Apply via
`aria-describedby`. **DOC-1 (Low)** — softened the "doc-org record §N" convention sentence. **RAG-2
(Low)** — clarifying comment (inheriting `includeArchived` is correct/consistent with `documentsInScope`;
no leak); no risky pin. **DEFERRED (with reason):** **UX-2** (formal "Sie/Ihre") + **UX-3** (attachment
`aria-live`, needs a new German "added" string) — both folded into the pending **D-L7 German-copy review**
rather than fixed ad hoc; noted in [`known-limitations.md`](docs/known-limitations.md). RAG-4/DOC-2/4 etc.
are correct-by-spec or stale-but-permitted nits (left as-is). **Tests:** typecheck clean, build OK,
`npm test` **1243 passed / 25 skipped** (+8): **TEST-1** (real crash-resume flow through the
`reindexDocument` IPC — reconcile→failed→re-index→asserts PROJECT membership; fails pre-DM-1) + a
generated-guard test; **DM-2/TEST-9** (origin stamped while `queued`; re-open backfill never files it);
**TEST-8** (a doc in BOTH a picked collection AND `documentIds` counts each chunk once); **TEST-2**
(folder exact-before-contains ordering + cohort tie-break most-common-then-lexicographic-id) + **TEST-5**
(engine tolerant of a malformed `origin` shape); **SEC-1** settings array validation. **Docs updated:**
architecture.md §1 M1 row + §4 (single indexing-success entry point) + §6 (origin stamped at queue time);
rag-design.md §13.6 (legacy-path scoped honesty); known-limitations.md (UX-2/UX-3 deferred). No version
bump, no skipped hooks. **Next:** the D-L7 German-copy review (UX-2/UX-3 + the Phase D/E/F German flags);
owner-gated Phase E.2; or new work._

_(prior) 2026-06-14 — **Document organization — Phase F (Filing suggestions, rule-based +
non-silent).** Sixth and final v1 phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md)
(esp. §5 non-goals, §11.2, §12.3, §16, §17, §19, §20 "Phase F", §21 Q8/Q9). **Rule-based ONLY — no
model, no network, no telemetry, never silent, never auto-file.** **Engine** (new pure, LOCAL,
deterministic [`filing-suggestions.ts`](apps/desktop/src/main/services/filing-suggestions.ts)):
`suggestFilingForDocument(doc, collections, allDocs)` returns ranked, de-duped suggestions
(`{ruleId, target: existingProject|newProject, reasonKey: MessageKey, reasonParams}`) via three rules,
highest-confidence first — **(1) folder-name match** (`source_folder_label` equals/contains an active
project name), **(2) same-source-folder cohort** (other docs sharing the folder are filed in project X),
**(3) bilingual filename pattern** (small documented EN-canonical+German token tables: invoice/receipt/
bill/statement·Rechnung/Beleg/Quittung/Kontoauszug, contract/agreement·Vertrag/Vereinbarung → a matching
existing project else a `newProject` with a canonical English name). **Subjects EXCLUDED** (D3/§7):
generated (`origin != null`), Temporary/archived lifecycle, and already-project-filed docs — and archived
projects are never suggestion targets. Tolerant: missing/empty metadata ⇒ no suggestion, never throws;
**deterministic** (no clock, no randomness). **Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)):
new `FilingRuleId`/`FilingTarget`/`FilingSuggestion`/`FilingSuggestionResult` (reason is an i18n KEY +
params, NOT free text); new `AppSettings.dismissedFilingSuggestions: string[]` (DEFAULT `[]`) — dismissals
persist in the **existing settings JSON blob, NOT a new `documents` column** (additive, tolerant, sticky
across restart). **IPC** ([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)): new
**read-only `docs:filingSuggestions`** ⇒ `suggestFilingForDocuments(listDocuments, listCollections)`;
mirrored in [`preload`](apps/desktop/src/preload/index.ts). **Apply reuses existing channels** (existing ⇒
`docs:addToCollection`; new ⇒ `collections:create` + `docs:addToCollection`); no new audit event — applying
records only `documents_added_to_collection` (id/type/count), so the suggestion REASON
(folder/pattern/project name) is **never** logged. **Renderer**
([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)): a quiet, dismissible
per-row chip ("Suggested project: Tax 2025 — Apply?" + a localized reason line + **Apply**/**Dismiss**) on
unfiled docs (its natural home is the Phase-E **Unfiled** view, also shown in All); Apply files via the
membership path then the doc leaves Unfiled; Dismiss hides it + persists via `updateSettings`; suppressed
once dismissed or when the target project vanished; reflow-safe (`.doc-suggest` flex-wrap, plan §12 L4).
**i18n**: new flat `docs.suggest.*` (chipExisting/chipNew/apply/dismiss/titles + reason.folder/cohort/
filename) EN+DE — reason strings are keyed templates; **German copy flagged for the D-L7 review.**
Forbidden-UI-words honoured. **Decisions locked:** rule-based only in v1 (local-AI classification is a
LATER owner-gated step, NOT built); auto-creating projects from top-level folders at import (§11.2/§21 Q8)
is a separate deferred follow-up (NOT built); dismissals in AppSettings (not a column); no new audit event
(reuse `documents_added_to_collection`, sentinel stays clean). **Tests:** typecheck clean, build OK,
`npm test` **1235 passed / 25 skipped** (+19: new [`filing-suggestions.test.ts`](apps/desktop/tests/unit/filing-suggestions.test.ts)
[12 — each rule incl. EN/DE patterns, ranking+de-dup, exclusions, archived-target, tolerance, determinism,
batch]; new [`filing-suggestions-ipc.test.ts`](apps/desktop/tests/integration/filing-suggestions-ipc.test.ts)
[2 — expected set + Apply existing via addToCollection + leaves-unfiled; Apply new via createCollection;
audit folder-label content-free]; `DocumentsScreen` [+4 — chip render+Apply-clears, Apply newProject,
Dismiss-persists-and-sticks-across-refresh, no-suggestion-no-chip]; GermanSmoke [+1 — German chip];
`audit-ipc` sentinel-grep extended with a FOLDER_SENTINEL (suggestion-reason) + the filingSuggestions
flow). No version bump. **Deliverable proof (covered by tests):** importing receipts from a "Tax 2025"
folder (or invoice/rechnung filenames) surfaces a quiet "Suggested project: Tax 2025 — Apply?" on Unfiled;
one click files the doc via the existing membership path; nothing is filed without that click; no model is
called, no network touched, and the audit log records only ids/counts — never the suggestion reason or any
name. **DOC-LIFECYCLE CLOSE-OUT (DONE — owner-confirmed 2026-06-14):** the whole v1 feature (Phases A–F;
E.2 owner-deferred) was condensed into §-numbered design records and
`docs/document-organization-plan.md` was **deleted** (full original in git: `git show
477f803:docs/document-organization-plan.md`). The records: **[`docs/architecture.md`](docs/architecture.md)
"Document organization — design record" §1–§8** (decisions D1/D2/D3 + the audit fixes, data model,
services, IPC, generated provenance, audit, trade-offs); **[`docs/rag-design.md`](docs/rag-design.md) §13**
(the scope/retrieval half — `DocumentScope`, `resolveScope`, the arg-5 `RetrievalScope` union H3, the
membership-OR-id SQL filter, C1 archive, D3/N1 generated exclusion, N2 filename auto-scope, M2 scoped
re-index); **[`docs/user-guide.md`](docs/user-guide.md) §7** (the user-facing Library/Projects/Temporary/
Generated/Archived + source picker + filing suggestions copy). The two in-code doc pointers
([`types.ts`](apps/desktop/src/shared/types.ts), [`db.ts`](apps/desktop/src/main/services/db.ts)) and the
`known-limitations.md` C4 note were repointed to the new records (existing inline "plan §x" comments
resolve via git history). **Next:** owner-gated Phase E.2 (explicit retention + Temporary review
dashboard); local-AI filing suggestions (owner-gated); or new work._

_(prior) 2026-06-14 — **Document organization — Phase E (Smart views + generated staleness).**
Fifth phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §5,
§7.5/§7.6, §8.2, §12.1, §15.3, §16, §17, §19, §20 "Phase E"). **Additive, query-time only — no new
column, no migration, no parser/chunker/embedder change, no new audit events.**
**Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)): new `LARGE_FILE_BYTES` (10 MB),
`SmartListView`/`SmartViewPredicate`, a pure **`matchesSmartView(doc, view)`** (the single source of truth
for the smart-view predicates so the renderer rail and the `docs:list` filter never drift), and
`GeneratedStaleness`/`GeneratedStaleReason` + a pure **`generatedStaleness(doc, sources)`**.
**Smart views (§7.6/§12.1):** the remaining query-time views ship as section-rail entries + `docs:list`
`smart` predicates — Recently added (createdAt desc — **no new column**), Unfiled (no *project* membership;
Library/Temporary builtins don't count as filed), Needs re-index (`staleEmbeddings`), Large files
(`sizeBytes >= LARGE_FILE_BYTES`), Failed imports (`status='failed'`), Audio (audio mime / generated
transcript), OCR/scanned (`ocr != null || scanDetected`). **IPC**
([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)): `DocumentListFilter.smart` widened
to `SmartListView`; `filterDocuments` routes `recent`⇒createdAt-desc order, `all`⇒no-op, else
`matchesSmartView`. **Renderer** ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)):
`DocSection` union + `inSection` extended (generated/archived/unfiled/needsReindex/large/failed/audio/ocr
delegate to `matchesSmartView`; `recent` ordered in `visibleDocs`); a **Views** rail group reusing the
projects-group layout so the existing 760px reflow applies (L4, no horizontal page scroll). **Generated
staleness (§15.3):** `generatedStaleness` is a tolerant derivation over the already-listed `updatedAt`/
`lifecycle` fields (**no hot-path write**) — flags `source-changed` when a source was updated after the
output's `createdAt`, `source-removed` when a source is missing/archived; a legacy origin shape or a
malformed/empty `createdAt` ⇒ no flag (never throws); a non-generated doc is never evaluated. Surfaced as a
quiet **Badge (icon + word, never color-only) + "re-run to update" copy** on the Generated rows; re-running
the task stays the only fix (snapshot semantics unchanged). **i18n**: new flat `docs.smart.*` (heading +
7 view labels) + `docs.provenance.stale{Badge,Changed,Removed}` EN+DE — **German copy flagged for the D-L7
review.** Forbidden-UI-words list honoured (no bucket/vector/scope_json/FTS/collection_id/membership/
embedding). **Decisions locked:** smart views are query-time predicates, **not** stored collections
(`CollectionType` keeps `'smart'` reserved-unused) and **not** pickable retrieval scopes in v1 (§13.2);
"Recently added" uses `createdAt` (no column) — `last_used_at`/"Recently used" (L2) stays deferred.
**Explicitly DEFERRED (owner-gated Phase E.2, NOT built):** explicit retention + Temporary review dashboard
(§14.3 — needs the reserved `expires_at` column, a review-before-delete UI, default Never, must never touch
Library/generated/project-filed docs, must shred sidecars under an encrypted workspace); `last_used_at`
(§8.2 L2). **Tests:** typecheck clean, build OK, `npm test` **1216 passed / 25 skipped** (+16: new
[`smart-views.test.ts`](apps/desktop/tests/unit/smart-views.test.ts) [each predicate incl. Unfiled
project-vs-Library-only + the 7 staleness cases]; `docs-ipc` smart-view filter + recent ordering;
`DocumentsScreen` smart-rail filter + staleness-badge-on-stale-not-fresh; GermanSmoke extended for the new
keys). No version bump. **Deliverable proof (covered by tests):** the Documents screen exposes the full
smart-view set; a translation whose source was re-indexed after it was generated shows a quiet "source
changed — re-run to update" badge in Generated while an untouched one does not — with no new column, no
retrieval change, and the audit log still content-free. **Next:** Phase F — filing suggestions (rule-based
first, never silent); or owner-gated Phase E.2 (explicit retention + Temporary review dashboard)._

_(prior) 2026-06-14 — **Document organization — Phase D (Generated provenance, D3/N1).**
Fourth phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §2.3, §7.4,
§15.1–§15.3, §16, §17, §19, §20 "Phase D"; decisions D3/M4 + audit N1). Gives generated
translation/comparison documents **structured provenance** and locks the **no-membership** invariant.
**Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)): new `GeneratedProvenance`
(`{kind:'summary'|'translation'|'compare'|'transcript'|'other', sourceDocumentIds[], sourceCollectionIds?,
modelId?, createdAt}`) + `GeneratedKind`; `DocumentOrigin` widened to the union
`TranslationOrigin | CompareOrigin | GeneratedProvenance` (reuses `origin_json` — **no new column**); a new
**`provenanceView(origin)`** normalizer collapses old+new shapes to `{kind, sourceDocumentIds}` so the UI
has one code path. **Read** ([`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts)):
`parseOrigin` now reads the structured shape FIRST (by `kind`+`sourceDocumentIds`, narrowed via a
`GENERATED_KINDS` tuple), then falls back to the legacy `type`/`translatedFrom`/`comparedFrom` branches
**unchanged** (old rows keep parsing); malformed ⇒ null, never throws (tolerant — `createdAt` defaulted to
`''` when absent). **Write** ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)):
a new `buildProvenance(kind, sourceIds, modelId)` builds the `GeneratedProvenance` translation/compare now
write (capturing `modelId=runtime.modelId` + a de-duped `sourceCollectionIds` snapshot via new
[`collectionIdsForDocument`](apps/desktop/src/main/services/collections.ts)); `materializeDocument`'s
`origin` param is now `GeneratedProvenance`. **N1/D3 locked:** a generated row still gets **NO**
`document_collections` membership at all (doctasks call `createQueuedDocument`+`processDocument` directly,
never `fileFromPendingDestination`/`fileIntoLibraryIfUnfiled`), so it is **structurally excluded** from
every collection-derived scope and reachable only via explicit `documentIds` (or download + re-import).
`role='generated'` stays a reserved-unused enum string; the `role <> 'generated'` predicate stays dropped.
**Renderer** ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)):
`provenanceLine` + the PreviewModal origin line now render from `provenanceView` (kind+source ids), not the
parsed display strings — "Translated from …" / "Comparison of … and …" / new "Summary of …" /
"Generated from …"; source titles still resolve tolerantly (deleted source ⇒ "a removed document"). The
Generated section view (`origin != null`) + Export/Download are unchanged; snapshot semantics unchanged
(no auto-update; **staleness UI is Phase E** — v1 only persists `createdAt`+`sourceDocumentIds`). **i18n**:
new flat `docs.provenance.summaryBefore`/`generatedBefore` EN+DE — **German copy flagged for the D-L7
review.** **Decisions locked:** generated docs out of the DEFAULT corpus structurally (no predicate);
summaries stay `summary_json` metadata (NOT materialized — `kind:'summary'`/`'transcript'` reserved for
forward use); additive/nullable only, `origin_json` reused, tolerant parse everywhere; no parser/chunker/
embedder change; no new audit events. **Tests:** typecheck clean, build OK, `npm test` **1200 passed /
25 skipped** (+3 net: doctasks-translation gains structured-provenance+zero-membership+sourceCollectionIds
and new-shape-round-trip/old-shape-back-compat/malformed-null tests; DocumentTranslate gains a
new-structured-shape label render; existing doctasks-translation/compare + audit-ipc origin assertions
updated to the new shape — extended, not broken; audit sentinel stays clean). No version bump.
**Deliverable proof (covered by tests):** translate report.pdf ⇒ the output shows "Translated from
report.pdf" from structured provenance, sits in Documents → Generated, carries ZERO collection membership
(so it's absent from a Library/project answer), is answerable only when hand-picked, and is made durable by
Download + re-import (Phase C). **Out of scope (Phase E+):** smart views beyond Generated; explicit
retention; staleness/auto-update UI; converting summaries to documents. **Next:** Phase E — Smart views +
cleanup (Generated/Recently added/Unfiled/Needs re-index/… + optional explicit retention with review UI)._

_(prior) 2026-06-14 — **Document organization — Phase C (Temporary analysis).**
Third phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §2.5, §7.3,
§11.1–§11.4 D2, §13.1/§13.3/§13.5, §14.1/§14.2, §16, §17, §19, §20 "Phase C"; audit C3/H1/H2/M1/N3/N4/N12).
Builds the **net-new chat attach / drag-drop intake** + import-destination filing over the Phase-A/B
backend. **Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)): new `ImportDestination`
(`{kind:'library'} | {kind:'collection';collectionId} | {kind:'temporary'} | {kind:'conversation';conversationId}`)
+ `ImportOptions` (`{destination?, preserveRelativePaths?}`). **Ingestion**
([`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts)): `createQueuedDocument(db, path,
opts)` now persists the resolved destination into `documents.pending_destination_json` **at queue time**
(M1) + folder `source_relative_path`/`source_folder_label`; new `expandPathsWithSource` (N12 folder
metadata, L3 basename fallback); a bare-string 3rd arg still means `displayTitle` (doctasks caller
unchanged). **Filing** ([`collections.ts`](apps/desktop/src/main/services/collections.ts)): new
`fileFromPendingDestination` (the single indexing-success entry point — reads `pending_destination_json`,
files, clears; NULL ⇒ Library default so old options-less imports stay byte-for-byte; also the crash-resume
path), `fileDocumentByDestination`, `linkConversationDocument` (**FK-guarded N3** — verifies the conversation
exists, try/catch the check-then-insert race; skip the link, keep the doc in Temporary if it's gone;
append-only `ON CONFLICT DO NOTHING`), `conversationAttachmentIds`, `parsePendingDestination` (tolerant).
A conversation/temporary destination ⇒ Temporary membership + `lifecycle='temporary'`; conversation also
writes the `conversation_documents` link (C3) — **never** `scope_json` (H4/N5). **IPC/preload**:
`docs:import` extended to `(paths, options?)` (the loop now files via `fileFromPendingDestination`, replacing
the Phase-B blanket `fileIntoLibraryIfUnfiled`); new **`chat:listAttachments`** (the conversation's
`conversation_documents` docs for the footer); both mirrored in [`preload`](apps/desktop/src/preload/index.ts).
A renderer-untrusted `ImportDestination` is sanitized in the IPC (`sanitizeDestination` ⇒ Library fallback).
**Renderer**: [`ChatScreen.tsx`](apps/desktop/src/renderer/screens/ChatScreen.tsx) gains a chat-surface
**drag-drop target** + a Composer **📎 attach** picker (`onAttach`), the **intake** (`attachFiles` →
`importDocuments(paths,{destination:{kind:'conversation',…}})`), **plain-chat drop routing** (§13.5/H2:
documents chat ⇒ attach in place; empty ⇒ switch in place to a new documents conversation; an in-progress
plain chat ⇒ **create+commit a NEW documents conversation before** the import references its id (N3), focus
it, toast — **never** mutate/clear the plain chat), and the **pending chip → live attachment** transition
(N4, driven by the existing `getImportJob` polling); [`ScopePopover.tsx`](apps/desktop/src/renderer/chat/ScopePopover.tsx)
shows a read-only **"Files in this chat"** line (attachments always unioned in, NOT removable chips; a
processing one is a pending chip) + a "· N file(s) in this chat" footer suffix;
[`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx) "Move to project" on a
**Temporary** doc now also makes it permanent + drops Temporary membership (§14.1; Keep-in-Library already did).
**i18n**: new flat `chat.attach.*` keys (button/drop/processing/newDocChat/failed) EN+DE — **German copy
flagged for the D-L7 review.** **Decisions locked:** temporary attachments live in `conversation_documents`
(C3), never `scope_v2_json`; the LINK (not Temporary membership) is authoritative for "files in this chat";
duplicate import is always-new (D2 — no sha dedup); deleting a conversation removes only the link (CASCADE),
never the doc (§14.2); no retention sweep in v1 (Phase E); no new audit events. **Out of scope (Phase D+):**
generated provenance; smart views / explicit retention. **Tests:** typecheck clean, build OK, `npm test`
**1197 passed / 25 skipped** (+18: destination filing round-trip + M1 crash-resume + N3 FK-guard + idempotent
link + `parsePendingDestination` in `collections.test.ts`; `docs-ipc` destination round-trip (temporary/
conversation/project + options-less Library); `chat-ipc` `listAttachments`; renderer `ChatAttach.test.tsx`
[empty-drop new conversation + pending chip, pending→live N4, plain-chat-with-messages new conversation +
toast, read-only Files-in-this-chat]; DocumentsScreen Keep-in-Library / Move-from-Temporary; GermanSmoke
attach button). No version bump. **Deliverable proof (covered by tests):** drop invoice.pdf into a chat ⇒
it imports as a Temporary `conversation_documents` attachment answerable in that chat, appears in Documents →
Temporary, and is NOT in Library until the user explicitly Keeps it. **Next:** Phase D — Generated provenance
(D3: `GeneratedProvenance`, no membership, structurally excluded, downloadable + re-importable)._

_(prior) 2026-06-14 — **Document organization — Phase B (Projects + composite scope, D1).**
Second phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §0.1 D1,
§8.3, §10.1, §12, §13, §16). Builds the user-facing surface over the Phase-A backend.
**Data contract** ([`chat.ts`](apps/desktop/src/main/services/chat.ts)): `Conversation` gains
`collectionId: string|null` + `scope: DocumentScope|null` (parsed tolerantly from `scope_v2_json` via the
relocated, now-exported `parseDocumentScope` in [`collections.ts`](apps/desktop/src/main/services/collections.ts));
`createConversation` gains `opts.collectionId`/`opts.scope`; new `setScope` (persists `scope_v2_json`,
empty scope = explicit "All documents", null clears) + `setConversationCollection` writers.
`updateConversationScope`'s legacy replace semantics are **unchanged** (H4/C3). **IPC/preload** (plan §16):
new [`registerCollectionsIpc.ts`](apps/desktop/src/main/ipc/registerCollectionsIpc.ts)
(`collections:list/create/rename/setArchived/delete`); [`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)
gains `docs:addToCollection`/`removeFromCollection`/`setLifecycle` + a `docs:list` filter
(`{collectionId?,lifecycle?,smart?}`) + **imports default-file into Library** on indexing success
(`fileIntoLibraryIfUnfiled`, zero-membership-guarded so re-index never re-files a project-only doc, keeping
"Library == all"); [`registerChatIpc.ts`](apps/desktop/src/main/ipc/registerChatIpc.ts) gains
`chat:setScope`/`setCollection` + the two `createConversation` opts. "Move" = add + remove (no channel).
**delete-project two modes** (plan §12.3): `membershipOnly` (CASCADE) and `withDocuments` (deletes ONLY
genuinely project-only docs — the C2 `projectOnlyDocumentIds` predicate counts ALL memberships so a Library
member is spared; reuses ingestion `deleteDocument`, which **now `shredFile`s** the stored copy instead of
`rmSync` — M5). Every channel mirrored 1:1 in [`preload/index.ts`](apps/desktop/src/preload/index.ts).
**Live ask path** ([`registerRagIpc.ts`](apps/desktop/src/main/ipc/registerRagIpc.ts)): now calls
`resolveScope(db, conversationId)`, passes the `RetrievalScope` to `generateGroundedAnswer` via `opts.scope`
(so `corpusNeedsReindex` is scope-aware — M2), and runs filename auto-scope **within** the resolved scope
(`documentsInScope` + `buildScopeFilter`), skipping it only when `hasExplicitDocSelection` (N2); the
STREAM.scope notice is kept. **DocumentInfo** gains `collections[]` (joined in `listDocuments`), `lifecycle`
(NULL⇒permanent), `sourceFolderLabel` (NOT `lastUsedAt` — L2). **Audit** (plan §17): `collection_created/
renamed/archived/deleted` + `documents_added_to_collection/removed_from_collection/document_lifecycle_changed`
— **id/type/count ONLY, never the project NAME** (asserted by the extended `audit-ipc` sentinel-grep with a
project-name sentinel). **Renderer**: [`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)
left **section rail** (Library/Projects/Temporary/Generated/Archived/All — responsive collapse at 760px) +
membership chips + lifecycle pills + an Organize per-row menu + bulk move/lifecycle + project
create/rename/archive/delete (two-mode confirm); [`ScopePopover.tsx`](apps/desktop/src/renderer/chat/ScopePopover.tsx)
is now a **multi-select source picker** (Library + each non-archived project + "Specific documents…" +
one-tap "All documents"; Temporary/Generated not pickable — N10/D3) writing a persisted `DocumentScope`;
the composer footer summarizes the composed union (`scopeFooterLabel`);
[`ChatScreen.tsx`](apps/desktop/src/renderer/screens/ChatScreen.tsx) derives the picker scope, persists via
`setConversationScope`, project-defaults the anchor on create, and shows the dangling/archived-project →
Library fallback notice (§13.4); [`ConversationList.tsx`](apps/desktop/src/renderer/chat/ConversationList.tsx)
groups by the creation-anchor `collection_id` with an "Other / Library" group when any chat is anchored
(`groupByProject`, additive — date grouping otherwise unchanged, N8). **i18n**: new flat `docs.section.*`/
`docs.action.*`/`docs.project.*`/`chat.scope.*`/`chat.list.otherGroup`/`diag.audit.collection_*` keys in
[`{en,de}.ts`](apps/desktop/src/shared/i18n) — **German copy flagged for the D-L7 review.** **Forbidden UI
words** (bucket/vector/scope_json/FTS/collection_id/membership/embedding) avoided. **Out of scope (Phase C+):**
chat attach/drag-drop INTAKE + `conversation_documents` writes + plain-chat drop; generated provenance;
smart views/retention. **Tests:** typecheck clean, build OK, `npm test` **1179 passed / 25 skipped** (+16:
new [`collections-ipc.test.ts`](apps/desktop/tests/integration/collections-ipc.test.ts) [CRUD, membership+
lifecycle+filtered list, C2 delete-with-documents spares a Library member, `chat:setScope` round-trip across
a DB reopen, resolveScope-in-IPC filename auto-scope + N2 skip] + chat scope/collection round-trip & writers &
C2 predicate in `collections.test.ts` + the audit sentinel/event extensions + renderer rail/project/picker
tests + GermanSmoke). No version bump. **Deliverable proof (covered by tests):** create project "Tax 2025",
ask over "Library + Tax 2025 + contractA.pdf" in one documents chat, and the composite scope persists across
an app restart (`scope_v2_json`). **Next:** Phase C — Temporary analysis (chat attach/drag-drop intake +
`conversation_documents` + destination chooser)._

_(prior) 2026-06-14 — **Document organization — Phase A (Collections core, backend
foundation).** First phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md).
Adds a collection-membership layer over the existing pipeline — one stored file, one chunk set,
one vector set per document; organization is metadata. **Schema** ([`db.ts`](apps/desktop/src/main/services/db.ts)):
three additive tables in the `SCHEMA` constant — `collections`, `document_collections`,
`conversation_documents` (the last two with **`ON DELETE CASCADE` on both FKs**, plan C4: with
`PRAGMA foreign_keys = ON` a pre-feature app's direct `DELETE FROM documents` would otherwise hit an
FK violation; CASCADE makes any build delete a doc cleanly) — plus indexes, plus nullable
`ensureColumn` additions (`documents.lifecycle`/`source_relative_path`/`source_folder_label`/
`pending_destination_json`/`expires_at`, `conversations.collection_id`/`scope_v2_json`; all NULL-sentinel
since the `ensureColumn` DDL grammar forbids DEFAULT/NOT NULL). **Migration** (`seedCollections`, run in
`openDatabase`, idempotent): seeds one **Library** + one **Temporary** built-in (by `type`, canonical
English names, UI localizes by type) and back-fills Library membership for every `status='indexed'`,
**`origin_json IS NULL`** (generated docs get NO membership — D3/N1), **unfiled** document (the
`NOT EXISTS` guard makes re-open a no-op; the `status='indexed'` gate is M1). **Services** (new
[`collections.ts`](apps/desktop/src/main/services/collections.ts)): CollectionService CRUD
(create/rename/archive/delete — built-ins undeletable/unarchivable, delete is membership-only via
CASCADE) + membership (add/remove, idempotent `ON CONFLICT DO NOTHING`) + `docLifecycle` coalesce +
**`resolveScope`** (a conversation's stored scope → a `RetrievalScope`: `scope_v2_json` composite ⇒
authoritative union; else legacy `scope_json`⇒specific docs / `collection_id`⇒project / else Library
default; chat attachments from `conversation_documents` always unioned in; `hasExplicitDocSelection`
set from hand-picks BEFORE merging attachments — N2; tolerant parse → never throws). **Retrieval**:
new neutral [`retrieval-scope.ts`](apps/desktop/src/main/services/retrieval-scope.ts) `buildScopeFilter`
(membership-OR-id UNION + document-level archived exclusion, plan §10.2/C1/D1) shared by `VectorIndex`
([`embeddings/index.ts`](apps/desktop/src/main/services/embeddings/index.ts)), `keywordSearchChunks`
([`rag/hybrid.ts`](apps/desktop/src/main/services/rag/hybrid.ts)), and scope-threaded `corpusNeedsReindex`
(M2); `retrieve`'s arg-5 is now a normalized union **`string[] | RetrievalScope | null`** (H3 — a bare
array/null still means legacy doc-ids, so **every existing positional caller/test is byte-identical**),
`generateGroundedAnswer` gains `opts.scope`. **Data contract:** `RetrievalScope`, `DocumentScope`,
`Collection`/`CollectionType`/`DocumentCollectionRole`/`DocumentLifecycle` in
[`shared/types.ts`](apps/desktop/src/shared/types.ts). **Deliberately deferred to later phases:** no IPC/
preload/renderer surface, no `Conversation.scope`/`collectionId` fields, no project UI, no chat attach
UI, no delete-with-documents, no audit events for collection ops, no `last_used_at` (L2) — Phase A is
backend-only and leaves observable behaviour **identical** (Library == all documents on day one). The
live ask path ([`registerRagIpc.ts`](apps/desktop/src/main/ipc/registerRagIpc.ts)) is **unchanged**;
`resolveScope` is built + tested but wired into the IPC in Phase B. **Docs:** version-skew note added to
[`known-limitations.md`](docs/known-limitations.md); the plan stays open (condensed into §-records +
deleted only when the whole feature ships — CLAUDE.md doc-lifecycle rule). **Tests:** typecheck clean,
build OK, `npm test` **1163 passed / 25 skipped** (+21: new `collections.test.ts` [seed/backfill,
CRUD, membership idempotency, CASCADE version-skew, resolveScope, no-network] + `rag-collections.test.ts`
[collection∪doc union, archived exclude/include + project-archive-doesn't-exclude C1, generated
structurally excluded + explicitly selectable D3, M2 empty-vs-stale split, legacy arg-5 unchanged]). No
version bump. **Next:** Phase B — projects + composite scope (IPC + multi-select source picker +
`Conversation.scope`/`scope_v2_json` wiring + conversation-list grouping)._

_(prior) 2026-06-13 — **Three post-MVP UI fine-tunes.** (1) **Chat example chips matched
the mode.** Plain Chat has no document access, yet its empty-state examples were document-shaped
("Summarize this contract" / payment terms / indemnity). Split into two key sets: `chat.exampleChat.*`
(explain a concept / write a polite email / brainstorm — general-purpose) for chat mode and
`chat.example.*` (now "Summarize this document" …) for the "Ask my documents" mode; `ChatScreen`
picks by `mode`. (2) **Nav rail labels no longer truncate.** `.nav-label` was `overflow:hidden +
text-overflow:ellipsis`, which clipped single long words on the ~80px rail ("Documents",
"Dokumente", "Einstellungen"). **Electron's Chromium ships no hyphenation dictionaries**, so
`hyphens:auto` is inert and a bare `break-word` splits mid-word with no hyphen ("Dokument"/"e").
Fix: the long labels carry explicit **soft hyphens (U+00AD)** in the i18n strings
(`nav.documents` = `Docu­ments`/`Doku­mente`, `nav.settings` = `Ein­stel­lungen`),
honored by `.nav-label { hyphens:manual; overflow-wrap:break-word }` — they wrap to a clean
hyphenated second line ("Doku-/mente", "Einstel-/lungen"); invisible when the word fits and in the
button `title=` tooltip. (`break-word` stays only as a last-resort net.) (3) **Engine banner no longer cries "demo mode" when chat works.**
The "Install the AI engine" warning gated on `EngineStatus.installed` (every fetchable family
present). A drive with the chat engine (`llama_cpp`) but no voice engine (`whisper_cpp`, empty
`runtime/whisper.cpp/win/` — the real cause on D:) showed the alarming demo-mode banner even though
chat answers for real. `ModelsScreen` now reads `missingFamilies`: strong **warning** only when
`llama_cpp` is missing; chat-present + voice-missing shows a quiet **info** note
(`models.voiceEngine.*`, "Add voice dictation (optional)"). **Files:** `renderer/screens/ChatScreen.tsx`,
`renderer/screens/ModelsScreen.tsx`, `renderer/styles.css`, `shared/i18n/{en,de}.ts`,
`tests/renderer/{ChatRestructure,GermanSmoke}.test.tsx`. **Docs:** `packaging.md` (banner-per-concern
bullet). **Tests:** typecheck clean, build OK, `npm test` **1142 passed / 25 skipped** (unchanged;
two assertions repointed to the new chat-example keys). No version bump._

_(prior) **Chat stream survives screen navigation.** A reply that was still
streaming when the user left the Chat screen and came back looked **idle** (the screen unmounts,
destroying its `streaming` state + token listeners), yet a new message was rejected with "a response
is already being generated" (the main-process generation, registered in `inFlightStreams`, kept
running). Fix: `withChatStream` now mirrors the accumulated answer + reasoning into a shared
**`streamBuffers`** snapshot (`ipc/inflight.ts`, cleared in lockstep with the `AbortController`) —
both `sendToken` and a new `sendReasoning` handed to `runFn` write to it, so chat + RAG buffer
identically. New read-only **`getActiveStream(conversationId)`** IPC returns the live snapshot (or
null). On mount/conversation-change the Chat screen, when it does **not** own a live stream, polls
`getActiveStream` (`STREAM_RECOVER_POLL_MS = 300`, only while one is in flight) and drives the same
streaming UI — live bubble (`streamText`/`streamThinking`), locked composer, Stop — via a derived
**`busyStreaming = streaming || recovering`** that replaced the bare `streaming` in every "no new
turn while answering" gate. The missed token events are not replayed; the snapshot carries the full
text so the bubble resumes complete, and completion (snapshot → null) refreshes the transcript from
the DB. **Files:** `ipc/inflight.ts` (+`streamBuffers`/`StreamBuffer`), `ipc/chat-stream.ts`
(`withChatStream` buffers + `sendReasoning`), `ipc/registerChatIpc.ts` (`getActiveStream` handler,
reasoning via `sendReasoning`), `shared/ipc.ts` + `shared/types.ts` (`getActiveStream` +
`ActiveStreamSnapshot`), `preload/index.ts`, `renderer/lib/polling.ts`,
`renderer/screens/ChatScreen.tsx`. **No streaming-contract change** (token/done/error/reasoning
channels untouched; the recovery path is additive + poll-based). **Tests:** typecheck clean, build
OK, `npm test` **1142 passed / 25 skipped** — +2 in `chat-stream.test.ts` (buffers content +
reasoning then clears on done; clears on error). _(No version bump this change, per request.)_

_(prior) **Two first-start UX fixes (follow-ups to the progress bar).**
**(1) Progress bar jumped "1 of 1" ↔ "2 of 2" on the AI Model screen.** `listModels` runs as
**overlapping passes** (a dev-StrictMode remount, the download poll), each computing a different
`modelCount` as the hash cache warms, and the progress events broadcast to the renderer — so the
bar flipped between interleaved passes. `ModelVerifyProgress` gained a **`runId`** (`randomUUID` per
`buildModelList` pass); the gate + Models renderers **lock onto the first `runId`** they see and
ignore the others until that pass's `done`. **(2) Model could be started twice (a disruptive
restart).** `RuntimeManager.start()` serialized but `doStart` stop-and-restarts when a runtime is
already current; with no "starting" state the AI Model screen's Start button stayed enabled while a
large GGUF loaded (tens of seconds), so a **revisit re-clicked Start** → two "Start runtime" log
lines, two backend selections (exactly the user's log). `start()` is now **idempotent** for the
in-flight/running model (a *switch* to a different model still stops the old one first), tracks
`startingModelId` (set synchronously, cleared on settle), and surfaces it on
**`RuntimeStatus.startingModelId`**. The AI Model screen now reads runtime status (polling while a
start is in flight) and shows a disabled **"Starting…"** button that survives a remount (the
per-click `busy` flag does not); the Chat no-model state says "your model is starting" while it is
set. **Files:** `shared/types.ts` (`ModelVerifyProgress.runId`, `RuntimeStatus.startingModelId`),
`services/models.ts` (per-pass `runId`), `services/runtime/index.ts` (idempotent start +
`startingModelId` in `status()`), `renderer/screens/{WorkspaceGate,ModelsScreen,ChatScreen}.tsx`,
`shared/i18n/{en,de}.ts` (`models.starting`/`models.startingTitle`, `chat.noModel.starting`).
**Docs:** `architecture.md` "Models & runtime" (progress-bar bullet + new idempotent-start bullet).
**Tests:** typecheck clean, build OK, `npm test` **1140 passed / 25 skipped** — repurposed the
concurrent-start test as a model *switch*, added **2** runtime tests (same-model double-start is one
start, no restart; already-running start is a no-op). German copy still wants the D-L7 review._

_(prior) **First-run model-verification progress bar.** The first cold pass
over a fresh drive hashes the multi-GB GGUF weights (minutes of USB I/O) behind what was an opaque
spinner. `buildModelList` now accepts an optional `onProgress(p: ModelVerifyProgress)` sink: a cheap
pre-pass (`statSync` + cache lookup, **no hashing**) sums only the bytes that will actually hash
(cached/missing/placeholder-hash weights excluded) into `overallBytesTotal`; `sha256File` streams a
running byte count (throttled to one callback per **64 MB** + a final exact-total flush) which the
loop re-weights into the overall total plus a 1-based `modelIndex / modelCount` step label; a terminal
`done` event settles the bar to 100%. **`overallBytesTotal === 0` (all cached — the common 2nd run) ⇒
no events, no bar.** The `listModels` IPC forwards the sink to the calling renderer over the new
`EVENTS.modelVerifyProgress` channel via `event.sender` (guarded by `isDestroyed()`); preload exposes
`api.onModelVerifyProgress`. **Surfaces (Gate + Models, per the chosen scope):** the first-run
`WorkspaceGate` *finishing* step and the first cold **AI Model** screen visit render the existing
`Progress` component (byte-weighted %, "Checking model N of M: name") in place of the spinner — both
keep their fallbacks (the gate's Skip + never-trap `catch`; the screen's calm "Checking…" hint).
**Additive behind the locked `listModels` contract**; no sink ⇒ zero overhead (legacy callers/tests
unchanged). **Files:** `shared/types.ts` (+`ModelVerifyProgress`), `shared/ipc.ts`
(+`EVENTS.modelVerifyProgress`), `services/models.ts` (`sha256File`/`sha256FileCached`/
`verifyChecksum`/`computeInstallState`/`buildModelList` + the no-hash `pendingHashBytes` pre-pass),
`ipc/registerModelIpc.ts` (forward via `event.sender`), `preload/index.ts`
(`onModelVerifyProgress`), `renderer/screens/{WorkspaceGate,ModelsScreen}.tsx`, `shared/i18n/{en,de}.ts`
(`gate.finishing.progress`, `models.checkingProgress`). **Docs:** `architecture.md` "Models & runtime"
→ new "Model verification progress (first-run bar)" bullet. **Tests:** typecheck clean, build OK,
`npm test` **1138 passed / 25 skipped** — +4 in `models.test.ts` (final-flush event; byte-weighted
monotonic progress + terminal `done`; no-events-when-cached; missing/placeholder excluded from the
denominator) and +1 renderer (`WorkspaceGate` drives the determinate bar then unsubscribes). **Open:**
the new strings still want the D-L7 German review; the Models-screen bar covers only the initial
loading state (a post-download cold re-hash isn't in that state — out of scope this pass)._

_(prior) **Onboarding follow-ups: whisper auto-install, embeddings card,
policy cleanup, responsive screens (0.1.14 cont.).** (1) **Engine installer generalized to all
families.** [`runtime-download.ts`](apps/desktop/src/main/services/runtime-download.ts) now drives
an `ENGINE_FAMILIES` list — `llama_cpp` (chat, `llama-server`) **and `whisper_cpp` (voice,
`whisper-cli`)`; one install fetches every missing family for the host (a family with no host build,
e.g. whisper on mac/linux, is skipped). `EngineStatus` gained `missingFamilies`; the banner copy
covers chat + voice. Doc: [`packaging.md`](docs/packaging.md) "In-app engine install" — how to add a
future family. (2) **Embeddings model card bug.** The document-search (embeddings) card showed
Select/Start (Start threw — only chat models are activatable) and an inconsistent "Active" badge.
Embeddings is now treated as **automatic** (like reranker/transcriber): no Select/Start, no Active
badge — "Used automatically once installed." Safe because retrieval uses `embedder.id` directly
([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts) already passes it), not the
`activeEmbeddingModelId` setting. (3) **policy.json cleanup.** `allow_telemetry` removed from the
generated file ([`drive.ts`](apps/desktop/src/main/services/drive.ts) `buildPolicyJson` +
prepare-drive `.ps1`/`.sh`) — the app has no telemetry and `buildPolicyStatus` hardcodes
`telemetryAllowed:false`; the runtime parser still tolerates the field. **`encryption_required` was
KEPT** — it is a deliberate, audited security control: `assertCommercialDrive` reads it from the
file using the DEFAULT (non-STRICT) base **on purpose** (M-4), so a sold drive must *explicitly*
declare encryption-required and cannot pass via the fallback. (Flagged to the user.) (4)
**Responsive screens.** Only Chat adapted below ~1150px (its JS list-collapse); added
[`styles.css`](apps/desktop/src/renderer/styles.css) `@media (max-width: 760px / 520px)` so Home /
AI Model / Documents / Settings / Diagnostics also reflow — slim nav rail, tighter gutters, stacked
`.kv` grids, wrapping card heads, scrollable segmented switchers. **Tests:** typecheck clean, build
OK, `npm test` **1133 passed / 25 skipped** (+2 engine family tests)._

_(prior) 2026-06-13 — **Onboarding fixes: network-on-by-default, in-app engine
installer, voice discoverability.** Three issues found testing the first-run flow.
**(1) Downloads possible by default:** `DEFAULT_SETTINGS.allowNetwork` flipped `false → true`
([`shared/types.ts`](apps/desktop/src/shared/types.ts)) so a fresh install can fetch models
out of the box. The **policy ceiling is still authoritative** — a commercial `policy.json`
with `allow_model_downloads: false` (or the packaged-build `STRICT_POLICY` fallback) keeps the
app offline regardless; telemetry stays hardcoded off. Updated `smoke.test.ts` +
`db-settings.test.ts` (the old "offline-first default" asserts) + the `policy.ts`/`types.ts`
"default off" comments; `download-ipc.test.ts` `makeCtx` now sets the setting explicitly so the
setting-off gate is still exercised. **(2) In-app engine installer (the real fix for "I
downloaded a model but it said mock mode"):** the model downloader fetches WEIGHTS only — without
the `llama-server` engine binary a started model falls back to the demo runtime
([`runtime/factory.ts`](apps/desktop/src/main/services/runtime/factory.ts) — "no llama-server
binary on the drive"). New [`services/runtime-download.ts`](apps/desktop/src/main/services/runtime-download.ts)
`EngineDownloadManager` fetches + SHA-256-verifies + extracts the host's prebuilt build from
`runtime-sources.yaml` into `runtime/llama.cpp/<os>/` (download → verify → clean → extract →
flatten → install marker — mirrors the canonical fetch-runtime scripts), with the network
(`fetchImpl`) and extraction (`extractImpl`, default `tar -xf`) behind injected seams (suite stays
zero-network/zero-shell). Same gates as model downloads (policy ∧ `allowNetwork`), re-checked in
main. New `engine:status`/`download`/`getJob`/`cancel` IPC + preload + a **Models-screen
"Install the AI engine" banner** (warning tone, progress/cancel, demo-mode explanation) shown when
the engine is missing but a host build exists. New shared types `EngineDownloadJob`/`EngineStatus`;
12 tests in `engine-download.test.ts`. **(3) Voice mic discoverability:** the dictation mic was NOT
removed by the chat-UI polish pass (the Composer block is byte-identical) — it is availability-gated
on `ctx.transcriber != null` (whisper engine + model present). Per the "keep gated, improve
discoverability" decision the transcriber card copy now states it unlocks the 🎤 voice button
(EN+DE `models.hint.transcriber`). **Tests:** typecheck clean, build OK, `npm test` **1131 passed /
25 skipped** (+12). **Manual-smoke TODO:** the real network fetch + `tar` extraction of the b9585
build is only exercised by the injected seams in CI — verify end-to-end on a real drive (like the
GPU/PAID smokes)._

_(prior) 2026-06-13 — **Security-hardening wave (audit 2026-06-13 remediation).**
Fixed every MEDIUM + the quick-win LOW findings from the same-day multi-persona security
audit. (Per the doc lifecycle rule the audit report was condensed into this entry +
`security-model.md` and then deleted — the full report is recoverable from git history at
commit `f99bc86`, which added it.)
**M-1/M-2/M-3 (parser DoS):** new `services/ingestion/limits.ts` adds env-overridable
pre-parse caps — a **byte ceiling** (`HILBERTRAUM_MAX_DOC_BYTES`, 1 GiB), a **parse wall-clock
timeout** (`HILBERTRAUM_PARSE_TIMEOUT_MS`, 30 min; **audio exempt** so long transcriptions
aren't killed), a **PDF page cap** (`HILBERTRAUM_PDF_MAX_PAGES`, 5 000), and a **DOCX zip-bomb
guard** (`declaredZipInflatedSize` over the zip central directory; `HILBERTRAUM_DOCX_MAX_INFLATED_BYTES`,
1 GiB) — wired into `processDocument` + `pdf.ts`/`docx.ts`; rejection → friendly persist-canonical
`main.ingest.fileTooLarge`/`parseTimeout` (new i18n keys EN+DE + display map). **M-4/M-6 (policy
fail-open):** `policy.ts` gained `STRICT_POLICY` + an `{ isDev }` option on `loadPolicy`/`parsePolicy`/
`buildPolicyStatus`; a **packaged** build with a missing/malformed/partial `policy.json` now fails
**CLOSED** to the strict commercial posture (encryption required, plaintext off, models must verify,
network denied) — `isDev` threaded from `index.ts` + every model/download/core IPC call site. The
commercial sell gate keeps the DEFAULT base on purpose (no policy.json must FAIL the gate). This
neutralizes M-6 (unverified weight can't load on a packaged drive). **M-5 (arbitrary binary):**
`HILBERTRAUM_LLAMA_BIN`/`HILBERTRAUM_WHISPER_BIN` honoured **dev-only** (`resolveLlamaServerPath`/
`resolveWhisperCliPath` gained `{ isDev }`, default false=ignore+log; threaded through the
runtime/embedder/reranker/transcriber factories + benchmark probe). **LOW:** L-1 anchored the
loopback regex (`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`) + a "never gate enforcement" comment; L-2
rejects non-`https:` download URLs (`validateManifest` + the `downloadToFile` seam, new `isHttpsUrl`);
L-3 added `requireUnlocked()` + string-array filter to `importPreflight`; L-6 zeroes the KDF-derived
key before throwing `WrongPasswordError`. **Open hardening (deferred — see "Open hardening items"
below):** L-4 (opaque pick-token import redemption), L-5 (`lstatSync` symlink guard in `expandPaths`),
L-7 (build-script archive containment), L-8 (`npm ci` + committed lockfile in the build pipeline).
**Docs:** `security-model.md` (policy fail-closed §1, parser caps + env-override gating sections,
loopback note); the audit report itself was condensed here + deleted (recoverable at git `f99bc86`).
**Tests:** typecheck clean,
build OK, `npm test` **1119 passed / 25 skipped** (+24: ingestion-limits, policy fail-closed,
sidecar/transcriber override-gating, manifest/assets https, importPreflight gate, vault key-zero,
model-IPC fail-closed)._

_(prior) 2026-06-13 — **Encrypt the diagnostics log at rest.** `logs/app.log`
could carry file names/paths + model ids but sat in plaintext beside the encrypted DB; it is
now sealed under the **same vault key** as the DB/document cache. `services/logging.ts` became a
three-state machine: **`buffering`** (pre-unlock — lines held in a bounded in-memory buffer, no
disk writes; lost on a kill while still locked, the accepted trade), **`encrypted`** (after
`attachVaultKey(key)` from the unlock/create IPC — buffer + decrypted history sealed to
`app.log.enc`; rewritten on every `error`, on rotation `app.1.log.enc`, and on lock/quit via
`detachVaultKey()` before `lock()` zeroes the key; `info`/`warn` ride the next flush;
`readLogTail` reads the in-memory buffer), and **`plaintext`** (after `usesPlaintextLog()` for a
`plaintext_dev` workspace — plain `app.log`, matching the unencrypted dev DB). The vault key
reaches logging via new `WorkspaceController.encryptionKey()` (same data key as `documentCipher()`).
**Password change** calls `rekeyVaultLog(newKey)` *after* a successful change — it re-seals the same
in-memory buffer under the now-current key (v1→v2 rotates the data key; v2 keeps it) **without**
re-loading from disk, which would discard history under a rotated key or **double** it under an
unchanged one. (The earlier detach-before/re-attach-after dance had exactly that doubling bug on the
common v2 path — fixed in the code-review pass.) **Hardening from the review:** buffer caps + the
rotation threshold are measured by **UTF-8 byte length** (not char count, so multibyte paths can't
blow past them); `loadEncrypted` trims on a **line boundary**; `app.1.log.enc` is written
**atomically** like the live `.enc`. Durability/rotation windows (info/warn lost on a hard kill;
`app.1.log.enc` recovery-only; stuck-at-gate session discarded) are now documented in code + docs.
**Migration:** `attachVaultKey` shreds any stale plaintext `app.log`/`app.1.log` an older build
left on an encrypted drive. **Files:** `services/logging.ts` (rewrite), `services/workspace-vault.ts`
(+`encryptionKey()`), `ipc/registerWorkspaceIpc.ts` (attach/detach/rekey in unlock/create/lock/change),
`main/index.ts` (plaintext switch at startup; flush before lock on quit + uncaughtException).
**Docs:** `security-model.md` ("Logs are local-only AND encrypted at rest" + design record),
`PRIVACY.md`, `known-limitations.md`, `drive-layout.md`. **Tests:** typecheck clean, build OK,
`npm test` **1095 passed / 25 skipped** (full suite green). logging.test.ts covers **14
tests** across the 3 modes + encrypted rotation + the migration shred + cross-session re-unlock +
the rekey no-double / v1 key-rotation + byte-boundary trim (+9 over the prior 5). _(Reminder: run the suite via `npm test` or from `apps/desktop` — a bare
`npx vitest` from the repo root finds no config, drops the `@shared`/`@renderer` aliases + jest-dom
setup, and falsely fails every renderer suite. See the run-vitest memory.)_

_(prior) **Chat-UI polish pass (branch `chat-ui-polish`).** A
focused, renderer-only calm/premium pass on the Chat screen + conversation history
(design-guidelines §3/§7). **What changed:** ① app nav → a compact ~80px **icon+label
rail** (`.app-shell` grid `80px 1fr`), active = soft neutral fill (accent reserved for the
focus ring); the **duplicate lower-left "Local · Offline" badge was removed** (the chat
header keeps the one ambient signal) and the lock became a quiet rail button. ② **history
rows** restyled: soft selected *fill* (the blue selection outline that read as keyboard
focus is gone), structured row (title + a quiet "📄 Documents" meta line replacing the loud
filled `DOC` badge), ≥40px tall; search mode gained a **"Results for '…'" header** +
2-line snippets + calmer empty copy ("I didn't find a match. Try rephrasing."). ③
**messages softened**: user turns → neutral tinted surface (no strong blue border),
assistant turns borderless (read as text, not nested cards), uppercase role chips → quiet
**You** / **HilbertRaum** labels; source cards lightened. ④ **composer** is now one bordered
shell with the Send/Ask button inside it (shell takes the focus ring). ⑤ **truthful
doc-scope copy**: "Using all 0 documents" is gone — zero docs → "📄 No documents yet · Add
documents" (jumps to Documents), some → "Using N documents", all → "Using all documents"
(no count). ⑥ **responsive**: history **auto-collapses ≤1150px** (`LIST_AUTO_COLLAPSE_PX`,
a `matchMedia` listener in ChatScreen OR-ed with the persisted preference; a session "peek"
override re-opens it while narrow), gutters tighten at ≤1280/≤1150px. **History was already
collapsible — refined, not reimplemented.** **Files:** `renderer/App.tsx`,
`renderer/styles.css`, `renderer/chat/{ConversationList,Composer,ScopePopover}.tsx`,
`renderer/screens/ChatScreen.tsx`, `shared/i18n/{en,de}.ts` (new keys `nav.aria`,
`chat.list.title/aria/docMeta`, `chat.search.resultsFor`; changed `chat.role.*`,
`chat.scope.*`, `chat.search.noMatches`; removed `chat.list.docBadge`/`chat.scope.usingAll.*`
plurals). **No backend / data-contract / IPC changes.** **Tests:** typecheck clean, build OK,
vitest **1085 passed / 25 skipped** (updated `InformationArchitecture` — the ambient
indicator is now header-only — and the scope/no-match copy assertions; +1 test). Eyeball
walk + before/after screenshots: `docs/design-review/chat-screenshots-after/` (BEFORE set:
`docs/design-review/chat-screenshots/`). Design record folded into `docs/design-guidelines.md`
§12. **Open:** German copy for the new strings still wants the D-L7 human review._

_(prior) **Rebrand: "Private AI Drive Lite" / "PAID" → "HilbertRaum".**
Repo-wide rename across code, design, and docs. User-facing brand "Private AI Drive Lite"
(and the bare "Private AI Drive") → **HilbertRaum** everywhere (window title, renderer brand,
i18n EN/DE copy, system prompt, READ ME FIRST, all docs + the spec, now
`CLAUDE_HilbertRaum_MVP.md`). The **`PAID` acronym was also retired from code identifiers**
(decision: full-depth rename, no in-field drives to preserve): env-var prefix `PAID_*` →
`HILBERTRAUM_*` (incl. every `PAID_*_SMOKE` manual harness + `HILBERTRAUM_DRIVE_ROOT` /
`HILBERTRAUM_MANIFESTS_DIR` / `HILBERTRAUM_LLAMA_BIN` / `HILBERTRAUM_WHISPER_BIN`); on-disk
working DB `paid.sqlite` → `hilbertraum.sqlite` (+ `.enc`/`-wal`/`-shm`); runtime install
marker `.paid-runtime.json` → `.hilbertraum-runtime.json`; **encryption format magic
`PAIDENC1` → `HRAUMEN1`** (8 bytes, encode/decode in `security/crypto.ts`); vault verifier
plaintext `paid-vault-verifier-v1` → `hilbertraum-vault-verifier-v1`; localStorage keys
`paid.uiLanguage` / `paid.chat.listCollapsed` → `hilbertraum.*`. Package names →
`hilbertraum` / `@hilbertraum/desktop`; electron-builder `appId` →
`space.hilbertraum.app`, `productName`/artifact → `HilbertRaum`; launcher files renamed
(`Start HilbertRaum.cmd`/`.command`, `start-hilbertraum.sh`). **These on-disk changes are
NOT backward-compatible** — an existing pre-rebrand vault/drive would not be recognized;
acceptable per the user decision (MVP not yet shipped). Typecheck clean, build OK, tests
green (1084 passed / 25 skipped — unchanged baseline)._

_(prior) UX polish: live dictation waveform in the chat composer —
`renderer/chat/Waveform.tsx`; record: wave-3 plan §10 + `architecture.md` "Voice dictation"._

_**Phase 42 (German QA + closeout) is DONE ⇒ the i18n wave
(Phases 39–42) is COMPLETE.** The working paper `docs/i18n-plan.md` was condensed into
the design record per the doc lifecycle rule — `docs/architecture.md`
"Internationalization — design record" (D-L1–L8; code comments cite "i18n record §N") +
`docs/design-guidelines.md` §7 "German microcopy"; full original:
`git show 5059ed8:docs/i18n-plan.md`. **One open item: the user's human review of the
German copy (D-L7 sign-off) — the Phase-42 change list was handed over for review.**_

**Where the project stands:** the MVP (Phases 0–13) is feature-complete and four post-MVP
audit rounds are fully remediated (§8). Every shipped wave since is DONE and condensed into a
design record per the CLAUDE.md doc lifecycle rule:

- **GPU acceleration (Phases 14–16)** + a same-day audit round —
  `docs/architecture.md` "GPU acceleration — design record" (§1–§8) + the as-built
  probe/ladder subsection.
- **Functionality wave 1 toward the Office edition (Phases 17–20):** RAG trust & scoped
  asking · in-app model downloader · audit log · answer-depth modes — record folded into
  the topic docs: `docs/rag-design.md` §10 (17) · `docs/architecture.md` "In-app model
  downloader" (18), "Audit log" (19), "Chat & streaming" (20).
- **Phase 21 retrieval quality** (hybrid FTS5 + RRF, optional reranker) —
  `docs/rag-design.md` §11 (as built) + §12 (design record, D8–D15); both manual
  measurements done (rerank smoke; `ragMinSimilarity` confirmed 0).
- **UI polish wave (Phases 23–27)** — [`docs/design-guidelines.md`](docs/design-guidelines.md)
  (ADOPTED; its §11 is the rollout record incl. decisions D-UI1–4).
- **Model catalog wave 1 + benchmark (Phases 28–29)** —
  [`docs/model-benchmarks.md`](docs/model-benchmarks.md) (protocol + first-run results +
  the §7 design record, D16–D22) + `docs/model-policy.md` (catalog + quality-aware
  recommendation + the disqualified-candidates list).
- **Functionality wave 3 (Phases 31–38):** conversation search · vault password change ·
  document tasks + summary · translation · compare · audio transcription · dictation · OCR —
  [`docs/architecture.md`](docs/architecture.md) "Functionality wave 3 — design record"
  (decisions D23–D37 in its §13; research gates R-S1/R-T1–2/R-W1–4/R-O1–3 with their banked
  findings in its §14; the per-feature as-built sections are elsewhere in `architecture.md` +
  `security-model.md`/`model-policy.md`/`drive-layout.md`/`known-limitations.md`). The plan file
  was retired into that record in the 2026-06-29 doc cleanup.
- **i18n wave (Phases 39–42):** English + German UI (`uiLanguage` setting + picker,
  pre-unlock gate language, full renderer sweep, the two-rule main-process boundary,
  German QA) — `docs/architecture.md` "Internationalization — design record" (D-L1–L8)
  + `docs/design-guidelines.md` §7 "German microcopy".

**Open:** Phase 22 (signed offline update bundles) is 🔴 blocked on a key-management design;
Phase 30 (opt-in big slot + embeddings) has a drafted working paper
([`docs/big-slot-embeddings-plan.md`](docs/big-slot-embeddings-plan.md)); the i18n wave's
German copy awaits the **user's human review pass (D-L7)** — the Phase-42 change list +
screenshots were handed over. Release-wise the
remaining work is **manual acceptance only** (§5). Consciously-accepted gaps live in
[`docs/known-limitations.md`](docs/known-limitations.md).

---

## 1. Current status

| Phase | Name | Status |
|---|---|---|
| 0 | Repo skeleton & tooling | 🟢 done |
| 1 | App shell, workspace & settings | 🟢 done |
| 2 | Model manifests & runtime contract | 🟢 done |
| 3 | Basic chat (mock runtime) | 🟢 done |
| 4 | Document ingestion & chunking | 🟢 done |
| 5 | Embeddings & vector search (mock) | 🟢 done |
| 6 | RAG chat with citations | 🟢 done |
| 7 | Hardware benchmark & recommendation | 🟢 done |
| 8 | Privacy & offline hardening | 🟢 done |
| 9 | Encrypted workspace | 🟢 done |
| 10 | Real llama.cpp runtime & embeddings | 🟢 done |
| 11 | Drive layout, scripts & packaging | 🟢 done |
| 12 | DIY asset loader (`fetch-assets`) | 🟢 done |
| 13 | Plug-and-play distribution (commercial drive) | 🟢 done |
| 14–16 | GPU acceleration (Vulkan distribution · probe/ladder runtime · surface) | 🟢 done 2026-06-10 — `architecture.md` GPU record §1–§8 |
| 17 | RAG trust & document-scoped asking | 🟢 done 2026-06-10 — `rag-design.md` §10 |
| 18 | In-app model downloader | 🟢 done 2026-06-10 — `architecture.md` "In-app model downloader" |
| 19 | Audit log (`runtime_events`) | 🟢 done 2026-06-10 — `architecture.md` "Audit log" + `security-model.md` |
| 20 | Answer-depth modes (Fast/Balanced/Deep) | 🟢 done 2026-06-10 — `architecture.md` "Chat & streaming" |
| 21 | Retrieval quality (reranker + hybrid FTS5 search) | 🟢 done 2026-06-10 — `rag-design.md` §11 (as built) + §12 (record); both manual measurements done |
| 22 | Signed offline update bundles | 🔴 blocked (key-management design) — outline in §5 item 3 |
| 23–27 | UI polish wave (tokens/theming · components · chat restructure · IA regroup · microcopy/ambient signal/first-run) | 🟢 done, merged to master 2026-06-10 — `docs/design-guidelines.md` (+ its §11 rollout record) |
| 28 | Model catalog wave 1 (challenger manifests, D16–D18/D22) | 🟢 done 2026-06-10 — 4 Apache-2.0 challengers, real hashes, all 10 catalog weights VERIFIED on `D:\`, bring-up smokes PASS |
| 29 | Benchmark protocol + first comparison run (D19/D20) | 🟢 done 2026-06-11 — judge-free QA+speed+RSS protocol run on all 8 models; RAM mins recalibrated, recommender quality-aware (`recommendation_rank`), Gemma thinking flag ON. Optional dev-box speed sweep = completeness only |
| 30 | Opt-in big slot + embeddings (D21 → D38–D43) | ⚪ not started — plan drafted (`docs/big-slot-embeddings-plan.md`) |
| 31 | Conversation search + permission-handler rider | 🟢 done 2026-06-11 — wave-3 record §4 |
| 32 | Vault password change (descriptor v2 envelope) | 🟢 done 2026-06-11 — wave-3 record §5 |
| 33 | Document tasks foundation + one-click summary | 🟢 done 2026-06-11 — wave-3 record §6 |
| 34 | Document translation workflow | 🟢 done 2026-06-11 — wave-3 record §7 |
| 35 | Compare two documents | 🟢 done 2026-06-11 — wave-3 record §8 |
| 36 | Audio transcription as ingestion (whisper.cpp sidecar family) | 🟢 done 2026-06-11 — wave-3 record §9 |
| 37 | Voice dictation in the composer | 🟢 done 2026-06-11 — wave-3 record §10 |
| 38 | Scanned-PDF / photo OCR (tesseract.js + `ocr/` assets) | 🟢 done 2026-06-11 — wave-3 record §11; **wave 3 COMPLETE** |
| 39 | i18n foundation + proof slice (shared `t()` + catalogs, `uiLanguage` + picker, pre-unlock language) | 🟢 done 2026-06-13 — `architecture.md` i18n record (§3.1/§3.2 + R-L1 finding) |
| 40 | i18n renderer string sweep (all screens/components, plurals, dates/numbers, shared-component `t` prop) | 🟢 done 2026-06-13 — `architecture.md` i18n record §5 |
| 41 | i18n main-process boundary (emissions via `tMain()`, persist-canonical English + D-L4 display map, dialog titles) | 🟢 done 2026-06-13 — `architecture.md` i18n record §3.3 |
| 42 | i18n German QA + closeout (de review, text-expansion audit, eyeball walk, docs) | 🟢 done 2026-06-13 — **wave COMPLETE**; record + Phase-42 QA notes in `architecture.md`; German human review (D-L7) handed to the user |

Legend: ⚪ not started · 🟡 in progress · 🟢 done · 🔴 blocked

> Remaining for *release* = **manual acceptance only** (§5): a real signed/notarized build +
> a USB spec-§17 demo (R5/R7), the GPU hardware matrix (§5 item 1b), the Activity-panel
> live-UI eyeball, the packaged-app OCR smoke.

---

## 2. Environment (verified 2026-06-09)

| Tool | Status |
|---|---|
| Node | v24.13.0 ✅ |
| npm | 11.6.2 ✅ |
| corepack | 0.34.5 ✅ (pnpm available if needed) |
| git | 2.54.0.windows.1 ✅ |
| winget | available ✅ |
| Rust / Cargo / rustup | ❌ NOT installed |
| Python | ❌ NOT installed |

OS: Windows 11 Pro (10.0.26200). Shell: PowerShell + bash both available.
Repo root: `f:\_coding\ai_drive`.

---

## 3. Decisions log

- **Stack = Electron + React + TS + Vite** (user choice; Rust not installed). Spec §4 permits Electron fallback.
- **Package manager = npm** with workspaces.
- **SQLite = `node:sqlite`** → fallback `sql.js` (WASM) if unstable. Avoid native `better-sqlite3`.
  ⚠️ **`node:sqlite` lives in the bundled Node of *Electron's main process*, not the system Node.**
  It needs Node ≥ 22.5. Electron 33 bundles Node 20 (no `node:sqlite`), so **Electron is pinned to
  `^37` (Node 22.x)**. Validate `node:sqlite` *inside Electron* at the start of Phase 1, not against
  system Node.
- **Mock-first:** `MockRuntime` + `MockEmbedder` so the app runs with zero model files. Real llama.cpp/embeddings deferred to Phase 10, behind the same interfaces.
- **Vector search = cosine over SQLite-stored vectors** for MVP.
- **Plaintext dev workspace allowed in dev**; encrypted is the commercial default (Phase 9).
- **YAML parsing = `yaml` npm package** (Phase 2 decision). Pure JS, no native deps, MIT, offline.
  Chosen over hand-rolling for reliability; parsing happens in the main process only. Validation is a
  hand-written pure function in `shared/manifest.ts` so it is shared with the renderer and unit-tested
  without I/O.
- **Manifest `local_path` is relative to the drive root** (existing Phase 0 manifests already include
  the `models/` prefix), so weight files resolve to `<root>/models/...`. Recommendation is data-driven
  via an optional `recommended_profiles` list on each manifest.
- **Ingestion parser libs (Phase 4): pure-JS, lazy-imported, externalized.** `pdfjs-dist` (PDF),
  `mammoth` (DOCX), `papaparse` (CSV) — no native deps, consistent with the `node:sqlite` choice.
  Imported lazily inside `parse()`. Marked **external** via `externalizeDepsPlugin` in
  `electron.vite.config.ts` (also externalizes `yaml`) so the large pdfjs ESM bundle is
  `require`/`import`-ed from `node_modules` instead of bundled (resolves R3). Main bundle shrank
  253 kB → 47 kB as a result.
- **PDF parsing approach (Phase 4):** use pdfjs-dist's **legacy** build
  (`pdfjs-dist/legacy/build/pdf.mjs`), which runs in the Node main process with **no Web Worker /
  no DOM** (validated). The `standardFontDataUrl` warning is harmless (rendering-only). Minimal
  ambient typings in `parsers/pdfjs.d.ts` (pdfjs ships no `exports` map for the legacy path).
- **Imported files are copied into the workspace** (`workspace/documents/`, `stored_path`), keeping
  `original_path` too → self-contained, re-indexable drive (spec privacy ethos). See Phase-4 contract.
- **Import = async with polling** (not the chat stream): documents table is per-file truth, job
  aggregate is in-memory via `getImportJob`. See Phase-4 contract for rationale.
- **Embedder placement (Phase 5):** `services/embeddings/` behind an `Embedder` interface
  (spec §9.2), mirroring `ModelRuntime`. A single `embedder` lives on `AppContext` (created in
  `main/index.ts` as `createMockEmbedder()`); the real E5/llama.cpp embedder is a localized
  Phase-10 swap. Ingestion takes the embedder as **optional deps** (`{ embedder?,
  embeddingModelId? }`) so Phase-4 callers/tests stay valid (no embedder → pass-through).
- **Vectors = `Float32Array`** (not `number[][]`) so BLOB encoding is a direct byte view and the
  real GGUF embedder fills typed arrays without conversion. **Dimensions = 384**, matching the
  E5-small manifest (`multilingual-e5-small-q8`) so the real swap is drop-in.
- **Embedding BLOB encoding (LOCKED):** `vector_blob` = raw little-endian Float32 bytes
  (`Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)`). Decode **copies** into a fresh
  4-byte-aligned buffer first (SQLite blobs can be unaligned → `Float32Array` view would
  otherwise `RangeError`). Tagged with `settings.activeEmbeddingModelId`, falling back to
  `embedder.id`.
- **Vector search = linear scan cosine** over the `embeddings` table for MVP (`VectorIndex`),
  with an ANN (sqlite-vec/HNSW) upgrade path behind the same `search` signature.
- **MockEmbedder = feature hashing** (SHA-256 tokens → signed buckets → L2-normalize),
  deterministic + fully offline (uses only `node:crypto`).
- **RAG service placement (Phase 6):** `services/rag/` (separate from `chat.ts`) holds the
  whole grounded path — `retrieve`, `buildGroundedPrompt`, `buildGroundedChatMessages`,
  `generateGroundedAnswer`, and the retrieval-settings mapper — reusing chat helpers
  (`appendMessage`/`listMessages`/`BASE_SYSTEM_PROMPT`) so the Phase-3 chat path is
  untouched. `askDocuments` is its own IPC module (`registerRagIpc.ts`).
- **Retrieval defaults (spec §7.8, LOCKED on `AppSettings`):** `ragTopKInitial = 12`,
  `ragTopKFinal = 6`, `ragMaxContextTokens = 2500`, `ragMinSimilarity = 0`. Read per request
  via `ragSettingsFrom(settings)`.
- **Dedup strategy:** dedup retrieved chunks by `(document_id, page_number)`, keeping the
  highest-scoring chunk per page. Page-less chunks (txt/md) are keyed by chunk id so they are
  **not** collapsed (page dedup would otherwise drop all but one window of a text file). The
  token budget always includes the single top chunk before enforcing `maxContextTokens`.
- **`[Sn]` labels assigned per query, never stored** (confirmed). Only the resolved
  `Citation[]` is persisted in `messages.citations_json`. **Retrieval is the source of truth
  for citations** — the mock runtime's echo has no real `[Sn]` markers, so computed citations
  are persisted directly (a real model emitting inline `[Sn]` still resolves against them).
- **`Citation.snippet` (additive):** `Citation` gained an optional `snippet` (truncated chunk
  text, ≤ `SNIPPET_MAX_CHARS` = 600) so the renderer's source panel shows the cited text and
  it survives reload via `citations_json`. Additive + optional → old rows are unaffected.
- **Grounding / empty-corpus copy:** when retrieval finds no usable chunks, the runtime is
  **not called**; a fixed `NO_DOCUMENT_CONTEXT_ANSWER` ("I couldn't find anything about that
  in your documents…") is persisted with no citations. Makes the no-hallucination guarantee
  deterministic + testable.
- **Grounded-prompt placement:** the grounded template (rules + question + numbered excerpts)
  replaces the **last user turn** sent to the runtime; the system message stays
  `BASE_SYSTEM_PROMPT`. The DB keeps the raw question (transcript/title).
- **Shared in-flight registry (`ipc/inflight.ts`):** chat + RAG share one
  `Map<conversationId, AbortController>` so the existing `stopGeneration` cancels either path.
- **Benchmark is strictly local (Phase 7):** `services/benchmark.ts` uses only `node:os` +
  `node:fs` + `node:crypto` — no `child_process`, no remote/GPU probes, no telemetry. A
  no-network assertion guards the whole path. Every probe is independently resilient: a
  failure yields a `null` value + a friendly warning, never a throw (a machine where
  everything fails still yields a valid `UNKNOWN` result).
- **Profile thresholds (spec §11.3, LOCKED):** RAM in **GiB** (`totalmem()/1024³`, rounded
  0.1); `≤8 → TINY`, `≤16 → LITE`, `≤32 → BALANCED`, else `PRO`; invalid RAM → `UNKNOWN`.
  **Downgrade rule:** `tokensPerSecond < VERY_LOW_TOKENS_PER_SECOND (3)` drops one step (never
  below TINY). **GPU rule:** a useful GPU bumps one step toward PRO (capped) — ~~GPU
  detection is best-effort `null` for now, dormant~~ **superseded by Phase 16**: the
  `--list-devices` probe feeds a precomputed `gpuUseful` hint (≥ 6144 MiB AND not
  integrated — `gpuUsefulForProfile`); `benchmark.ts` itself still never probes.
- **Drive-test bounds:** writes `DRIVE_PROBE_BYTES = 8 MB` of random bytes **inside the
  workspace**, times write (`fsync`) then read → MB/s; **always cleaned up** (`try/finally`);
  failure → `null` Mbps + `error`. **Slow-drive warning** at `< SLOW_DRIVE_MBPS (30)` MB/s —
  warn, never block.
- **Tokens/sec is optional in the mock era:** measured only when a runtime is active (prompt
  *"Write one sentence about privacy."*, up to 64 tokens); `null` otherwise. Real numbers land
  in Phase 10.
- **Benchmark persistence:** spec §8 has **no `benchmarks` table**, so the last result lives in
  the settings store as `AppSettings.lastBenchmark` (JSON `BenchmarkResult`, default `null`).
  **"Never benchmarked yet" default = `UNKNOWN`.** Both former stubs now read
  `lastBenchmark?.profile ?? 'UNKNOWN'`: `getAppStatus().hardwareProfile` and
  `buildModelList`'s `profile` (the `LITE` stub is gone). User-facing copy follows spec §11.4
  (never "your hardware is bad").
- **Policy shape + deny-by-default (Phase 8):** `services/policy.ts` models the spec §6
  `network`/`workspace`/`models` blocks as a camelCase `PrivacyPolicy`. `DEFAULT_POLICY` is
  **deny-by-default for network + telemetry** (both off); workspace/model defaults are
  developer-friendly (plaintext dev + unverified models allowed) since encryption enforcement is
  Phase 9 and model verification already gates on the `developerMode` setting. `config/policy.json`
  + `config/drive.json` are **optional**; missing/malformed → safe defaults **+ a warning, never a
  throw** (`bool()` only accepts real booleans, so junk fields can't weaken the policy).
- **Effective-network rule (LOCKED, Phase 8):** `networkAllowedByPolicy =
  allowModelDownloads || allowUpdateChecks`; `networkAllowed = networkAllowedByPolicy ∧
  user.allowNetwork`; `offlineMode = !networkAllowed`. A (future signed) policy is **authoritative**
  — it can only **restrict**, never expand, the user toggle. With no policy file the deny-by-default
  ceiling keeps the app offline even if `allowNetwork` is on (no network features ship before
  Phase 11 anyway). **Telemetry is always off** (no toggle, hardcoded `telemetryAllowed: false`).
- **`AppStatus.offlineMode` is now policy-aware** (was `!allowNetwork`); added
  `AppStatus.networkAllowed`. New `getPolicy` IPC (`policy:get`) returns `PolicyStatus` (effective
  policy + derived flags) so the UI distinguishes "off by choice" from "disabled by policy"
  (spec §3.6).
- **Loopback exception (LOCKED, Phase 8):** the offline self-check treats `127.0.0.0/8`, `::1`, and
  `localhost`/`*.localhost` as **not** network (dev renderer now; llama.cpp sidecar on 127.0.0.1 in
  Phase 10). Only remote origins are violations. `services/offlineGuard.ts`
  `installOfflineNetworkGuard` wraps `net.Socket.prototype.connect` and **only logs** a remote
  attempt — it never blocks or throws (a wrong host guess must not break local IPC/sidecar). The
  guard is installed in ALL builds when offline (an audit-round fix superseded the original
  dev-only gating); `assertOfflinePosture()` always logs the posture.
- **CSP dev-vs-prod split (Phase 8):** strict CSP applied as a response header
  (`session.webRequest.onHeadersReceived`) on top of the `index.html` meta tag. **Prod:**
  `default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. **Dev:** relaxes `connect-src` to `ws://localhost:* http://localhost:*`
  and adds `'unsafe-inline'`/`'unsafe-eval'` to **`script-src`** (+ `'unsafe-inline'` on `style-src`)
  for Vite HMR (a strict policy breaks `npm run dev`).
- **Logs-local guarantee (Phase 8):** confirmed `services/logging.ts` is the only log writer
  (rotating `app.log` under `logsPath`); nothing writes logs/crash data off-device. Stated as fact
  on the Privacy screen + PRIVACY.md. **Superseded 2026-06-13 (encrypted-log change):** still the
  only writer, but on an encrypted workspace it writes `app.log.enc` (sealed under the vault key),
  not plaintext — see the "Encrypt the diagnostics log at rest" entry at the top + `security-model.md`.
- **KDF = Argon2id (default for new vaults), scrypt still supported (Phase 9 → audit round 2, R4):**
  NEW vaults derive the key with **Argon2id** (OWASP-recommended) via the pure-JS, audited
  **`@noble/hashes`** — no fragile native `argon2` build (the original R4 blocker). Default params
  `m=19456 KiB (19 MiB), t=2, p=1, keyLen=32` (~0.5 s/unlock). `node:crypto` **`scrypt`** is fully
  supported still (`SCRYPT_KDF` = `N=2^15, r=8, p=1`) so any vault created under the earlier scrypt
  default unlocks unchanged: the descriptor records `algo` + params and `deriveKey` dispatches on them
  — **no on-disk format change**. `KdfParams` fields are per-algo (`scrypt: N/r/p` · `argon2id: m/t/p`),
  validated in `deriveKey`. New dep: `@noble/hashes` (pure-JS, externalized like the parser libs).
- **Whole-DB-FILE encryption-at-rest (Phase 9, plan §4b):** `node:sqlite` has no SQLCipher, so the
  whole file is encrypted (AES-256-GCM, fresh 12-byte IV/encryption, 16-byte tag) — **the spec §8
  schema is identical in both modes**. At-rest artifact = `hilbertraum.sqlite.enc` (framed
  `MAGIC|iv|tag|ciphertext`). **On unlock:** verify password against an authenticated verifier (no
  DB touched) → decrypt `.enc` → `hilbertraum.sqlite` **on the drive** → `openDatabase`. **On lock/quit:**
  `PRAGMA wal_checkpoint(TRUNCATE)` + close → re-encrypt → `.enc` → **shred** the plaintext working
  file + `-wal`/`-shm`. The plaintext working copy on disk while unlocked is a **documented
  limitation**; secure-erase is **best-effort** on SSDs (wear-levelling).
- **Vault descriptor = unencrypted `config/workspace.json` (Phase 9):** settings (incl.
  `workspaceMode`) live INSIDE the encrypted DB, so the app can't read them pre-unlock. The
  descriptor `{ version, mode:'encrypted', kdf{algo,N,r,p,keyLen}, saltB64, verifier{iv,tag,ct} }` is
  the **only** pre-unlock artifact; it holds salt + KDF params + an AES-GCM **verifier** (known
  plaintext under the key) — **never** the password or key (both memory-only). Tests scan the
  descriptor + `.enc` and assert the password is absent.
- **Plaintext gating now ENFORCED (Phase 9):** `plaintextAllowed(policy, {isDev, developerMode})` —
  `workspace.encryptionRequired` is an absolute veto; `allowPlaintextDevMode` must be true; AND the
  caller must be a developer (dev build / developer mode). Pre-unlock `developerMode` is unreadable
  (in the encrypted DB) so `isDev` is the proxy. ⇒ a commercial build (not dev, encryptionRequired
  or no policy file) **defaults to encrypted** and onboarding never offers plaintext.
- **Lock-on-quit + Lock-now (Phase 9):** `WorkspaceController.lock()` runs on `will-quit` (alongside
  `runtime.stop()`) and from a sidebar **Lock now** button. `lock()` is a **no-op for plaintext_dev**
  (nothing to protect; closing it would wedge the app back into onboarding) — the plaintext DB just
  stays open until process exit. `db` on `AppContext` is a **getter** over the controller
  (`requireDb()` throws while locked), so all existing `ctx.db` call sites are unchanged and track
  unlock/lock at call time.
- **Sidecar discovery + env override (Phase 10):** `resolveLlamaServerPath(rootPath, platform, env)`
  finds `runtime/llama.cpp/<os>/llama-server[.exe]` (`win`/`mac`/`linux` sub-dirs, spec §6); a
  `HILBERTRAUM_LLAMA_BIN` env var overrides for dev. Pure `existsSync` — the "binary present?" check has no
  I/O surprises. `findFreePort()` picks a free **loopback** port (listen `127.0.0.1:0` → read → close;
  an inbound bind, not the outbound `connect` the offline guard watches).
- **Localhost-only binding (LOCKED, Phase 10):** every sidecar is spawned with `--host 127.0.0.1` and
  every fetch targets `http://127.0.0.1:<port>`. **Never** `0.0.0.0`/a routable interface. The Phase-8
  offline guard exempts loopback for exactly this; the no-network assertions assume loopback-only. A
  unit test asserts the spawn args + fetch URLs are `127.0.0.1`, never `0.0.0.0`.
- **OpenAI-compatible streaming endpoint (Phase 10):** `LlamaRuntime.chatStream` POSTs to
  `/v1/chat/completions` with `stream:true`, sending `messages` as plain role/content (**the server
  applies the model's chat template** — we never hand-roll Qwen's prompt format) and mapping
  `maxTokens`/`temperature`. `readChatSSE` parses `data:` frames (partial-line buffering, ignore
  keep-alives, stop on `[DONE]`), `yield`s each delta, honours `options.signal`. Feeds the **locked
  Phase-3 streaming contract** unchanged ⇒ `measureTokensPerSecond` reports **real** tokens/sec once a
  real runtime streams.
- **Real-embedder backend = `llama-server --embedding` (Phase 10, R6):** `E5Embedder` composes the
  **same** prebuilt `llama-server` binary (`--embedding --pooling mean`) over loopback `/v1/embeddings`.
  Chosen over ONNX (onnxruntime-node + tokenizer = a heavier **native** add) because it adds **zero new
  npm deps** and no fragile native build — consistent with the `node:sqlite`/pure-JS theme. **Lazy-
  started on first `embed()`** and reused; an additive optional `Embedder.stop()` kills it (wired into
  `will-quit`). Same **id (manifest) + 384 dims + L2-normalized** output ⇒ drop-in behind the
  `Embedder` interface; the locked Float32 BLOB encoding + `VectorIndex` are unchanged.
- **Embedding-model-mismatch handling = filter by id (LOCKED, Phase 10):** mock (`mock-embedder`) and
  real E5 vectors are **both 384-dim**, so the dimension guard can't separate them — mixing them
  silently corrupts ranking. `VectorIndex` takes an optional `{ embeddingModelId }` that scopes the
  cosine scan to `WHERE embedding_model_id = ?`; `rag.retrieve` passes the **active embedder's id**.
  Chosen over a forced reindex-on-switch (cheaper, no re-embed pass; a reindex still re-embeds with the
  active model). Default (no id) scans all rows ⇒ existing callers/tests unchanged. A test proves a
  mock↔real switch can't blend vector spaces.
- **Script logic in a tested TS module + self-contained shell scripts (Phase 11):** the canonical
  layout/config/checksum logic lives in `services/drive.ts` and is unit-tested by vitest; the
  `scripts/*.{ps1,sh}` **re-implement the same plan natively** rather than shelling out to Node.
  Rationale: a drive must be preparable on a **fresh machine with no Node/npm** (and no TS runner is
  installed — tsx/ts-node absent), and tests must run in CI without PowerShell/bash. `drive.ts` is the
  documented source of truth; the small drift surface (dir list + JSON shapes) is cross-checked (the
  PS + bash + TS emit **semantically-equivalent** config — valid JSON the app parses identically).
  ⚠️ Not literally byte-identical: timestamps differ per run, and `ConvertTo-Json` whitespace differs
  from the bash here-docs. The PS scripts now write **UTF-8 without a BOM** (`Set-Content -Encoding
  UTF8` on PS 5.1 would emit a BOM that breaks Node's `JSON.parse`) — audit fix.
- **Drive-layout naming reconciliation (LOCKED, Phase 11):** the prepared-drive dirs follow the
  **code**, not the spec's prose. Sidecar OS sub-dirs are **`win`/`mac`/`linux`** (`sidecar.ts`
  `llamaOsDir`), and manifests live in a **top-level `model-manifests/`** (`models.ts`
  `resolveManifestsDir`) — NOT `windows/macos/linux` or `models/manifests/`. `drive.ts`
  `DRIVE_LAYOUT_DIRS` is canonical; `docs/drive-layout.md` was corrected to match.
- **Config-generator defaults (Phase 11):** `prepare-drive` writes `config/drive.json` (the
  prepared-drive marker `resolvePaths` keys off) + `config/policy.json`. **Network is ALWAYS
  deny-by-default** (the offline guarantee — `resolveNetwork` is policy ∧ user setting). The default
  posture is **commercial** (spec §6 example: encryption required, no plaintext, models must verify);
  a `-Dev`/`--dev` flag flips to a developer-friendly drive (plaintext + unverified allowed) but
  **still denies network**. JSON shapes are exactly what `parsePolicy`/`mergePolicyObject` accept
  (snake_case booleans). Files are written onto the **drive**, never committed.
- **checksums.json shape (Phase 11):** `{ drive_format_version, generated_at, algorithm:'sha256',
  entries:[{ id, local_path, sha256|null, size_bytes|null, present }] }`. Written by `verify-models
  --generate` from the weights present on the drive. **Informational** — the app still verifies
  against the manifest `sha256`; checksums.json records what a drive builder captured. Placeholder
  manifest hashes report **UNVERIFIED** (not pass, not fail), mirroring `computeInstallState`'s
  developer-mode gate (R5 checksum honesty).
- **Portable Windows target via electron-builder (Phase 11):** `electron-builder.yml` defines a
  `portable` Windows `.exe` (launch-from-drive) + `mac`(dir)/`linux`(AppImage) for parity.
  `model-manifests/` ship as `extraResources` (found via `resolveManifestsDir(app.getAppPath())` →
  `resources/model-manifests`; `HILBERTRAUM_MANIFESTS_DIR` overrides); prod deps (the externalized parser
  libs) ship inside `app.asar`; Electron stays **≥37** so `node:sqlite` exists. `npm run package` /
  `package:win` wired. **Building the real artifact is a MANUAL step** (R2 Electron download; npm
  workspace dep-hoisting may need attention) — it is NOT part of the green gate.
- **Graceful-fallback rule (LOCKED, Phase 10):** the real backends are **opt-in by availability**.
  `createSelectingRuntimeFactory` (per `start()`, when the model path is known) and
  `createSelectedEmbedder` return the real `LlamaRuntime`/`E5Embedder` **only when BOTH** the
  `llama-server` binary **and** the GGUF weights exist; else the mock. ⇒ the app launches and the whole
  suite passes with **zero model files** (the repo/CI default). The embedder reads its model from the
  **manifest** (settings live in the possibly-encrypted DB, unreadable pre-unlock).
- **Optional manifest `download` block (Phase 12, additive):** `shared/manifest.ts` gained an
  **optional** `download: { url, sha256, size_bytes?, license_url? }` validated **only when present**,
  so every existing manifest stays valid. A **real** `download.sha256` must equal a **real** top-level
  `sha256` (same file); placeholders pass through. The four committed model manifests now carry real
  upstream URLs (Qwen3 GGUF + multilingual-E5) with `sha256` left as the `REPLACE_WITH_REAL_HASH`
  placeholder (a placeholder = "fetch then capture via `verify-models --generate`"). The legacy
  `download_url: null` field was removed.
- **`runtime-sources.yaml` (Phase 12):** the `llama-server` sidecar is NOT a model, so it gets a
  committed `model-manifests/runtime-sources.yaml` (`llama_cpp: { version, builds:[{os,arch,backend,
  url,sha256,extract_to}] }`) validated by `shared/runtime-sources.ts` (`validateRuntimeSources`,
  mirroring `validateManifest`). **Excluded from model discovery** via `RESERVED_MANIFEST_FILES` in
  `models.ts` (it would fail `validateManifest`). **Default backend = CPU** (AVX2 win/x64, Metal
  mac/arm64, plain CPU linux/x64) — broadest-compatible for an unknown laptop; GPU is an opt-in
  `--backend` override. `selectRuntimeBuild` returns the **first** os/arch match when no backend is
  given (the CPU build is listed first per OS).
- **Build-time network ≠ runtime network (LOCKED, Phase 12):** the `fetch-*` scripts make the
  project's first deliberate network access, but run on the **drive-builder's online machine at build
  time, NOT in the app at runtime**. The app stays 100% offline by default; the optional in-app
  downloader (the then-deferred provisioning item, later Phase 18) stays policy-gated (`network.allow_model_downloads`, deny-by-default) **and**
  behind the user `allowNetwork` setting. The offline guarantee is unchanged. The in-app downloader
  was **DEFERRED** (not required for the DIY acceptance criteria).
- **Verify-before-trust + license gate (LOCKED, Phase 12):** every downloaded artifact is
  SHA-256-verified **before** it counts as installed — a real-hash mismatch deletes the partial and
  exits non-zero; a **placeholder** expected hash downloads but reports *UNVERIFIED* (never a silent
  pass). The license gate refuses to plan/fetch a model whose `license_review.status != approved`
  unless `--accept-license`/`-AcceptLicense` is set (license + `license_url` printed first). Downloads
  are **resumable** (`curl -C -` / `aria2c`) and **idempotent** (present + verified → skip fast).
- **`services/assets.ts` is the canonical asset-loader logic (Phase 12):** mirrors `drive.ts` — the
  scripts re-implement the same plan natively (self-contained, no Node/npm). Pure/testable:
  `planModelDownloads` (fs reads, NO network), `selectRuntimeBuild`, `planRuntimeDownload`
  (escape-guarded paths reusing `weightPath` semantics), `verifyDownloadedFile`, and an injected-fetch
  `downloadToFile`/`fetchAndVerify` seam (the network seam a future §12.3 downloader reuses; tests
  drive it with a fake `fetch` so the **no-network assertion holds**). The scripts' `.ps1` files are
  **pure ASCII** (Windows PowerShell 5.1 reads non-BOM scripts in the ANSI codepage; a UTF-8 em-dash's
  `0x94` byte decodes to `"` and breaks a double-quoted string — same class of bug as the Phase-11
  BOM issue).
- **Launcher resolves the drive root from its OWN location (LOCKED, Phase 13):** the per-OS launcher
  (`Start HilbertRaum.{cmd,command}` / `start-hilbertraum.sh`) sets `HILBERTRAUM_DRIVE_ROOT` from
  where it sits (`%~dp0` / `dirname "$0"`), **never** a hardcoded drive letter — drive letters/mounts
  change per machine, and the same drive must continue the **same encrypted workspace** on a second
  laptop (success criterion #10; `resolvePaths` already redirects all state onto the drive). Canonical,
  unit-tested resolver = `services/launcher.ts` `resolveDriveRootFromLauncher(launcherPath, flavor?)`
  (handles Windows drive-letter + POSIX paths, rejects empty/relative). The launcher scripts mirror it.
  **Autorun is dead** (Windows disabled `autorun.inf` from removable drives) — the app cannot
  auto-launch on plug-in and must not try; the drive opens a window and the buyer double-clicks the
  well-named launcher (+ a root `READ ME FIRST.txt`).
- **Signing/notarization is a documented MANUAL step; the green gate never signs (LOCKED, Phase 13):**
  `electron-builder.yml` wires `win.signtoolOptions` + `mac.notarize`/`hardenedRuntime` +
  `build/entitlements.mac.plist`, but ALL secrets come from **env vars / a git-ignored secrets file on
  the build machine** (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; `CSC_LINK`/`APPLE_ID`/
  `APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) and **never enter the repo** (`.gitignore` excludes
  `*.pfx`/`*.p12`/`*.cer`/`*.key`/`signing.env`/`*.provisionprofile`). The green gate
  (`typecheck`/`test`/`build`) does not invoke electron-builder, so signing is off the critical path
  (like the R2 Electron download). EV (Windows) builds SmartScreen reputation fastest; macOS without
  notarization is quarantined. The unsigned DIY "Run anyway" / right-click→Open fallback stays in
  `docs/troubleshooting.md`. New procurement risk **R7** (cert cost/lead-time) blocks only the
  *commercial* acceptance.
- **`build-commercial-drive` = plan + final posture assertion, mirrored by scripts (LOCKED, Phase 13):**
  `services/commercial-drive.ts` is the canonical, unit-tested reference (like `drive.ts`/`assets.ts`):
  `planCommercialDrive(opts) → CommercialStep[]` + `formatPlan` (the ordered steps: prepare → fetch-
  models → fetch-runtime → **package/sign [manual]** → copy launcher+app+docs → verify-models --generate
  → assert) and `assertCommercialDrive(root, manifests) → { ok, problems[], checks, modelResults }`
  which **reuses `loadPolicy` + `verifyDriveModels`** to assert the **commercial posture** (encryption
  required, plaintext off, models must verify, **network denied**) + **every weight VERIFIED** + **no
  user data present** (spec §12.2 — fails loudly otherwise). `scripts/build-commercial-drive.{ps1,sh}`
  orchestrate the existing Phase-11/12 scripts (NOT re-implementing them) + a native cross-check of the
  same invariants. ⚠️ PS gotcha fixed: invoke sibling scripts via **hashtable** splatting
  (`& $path @{Target=…}`), not array splatting (array splat binds positionally → `-Target` is rejected);
  reset `$global:LASTEXITCODE = 0` before each call so a stale code isn't misread.
- **Launch preflight reuses the benchmark; non-blocking (LOCKED, Phase 13):** `services/preflight.ts`
  `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) → PreflightResult` reuses
  `buildDriveStatus` (writable + free space) + `measureDriveSpeed`/`buildWarnings` (the spec §11.4
  slow-drive copy) — it does NOT add a second drive probe. Friendly + **non-blocking** (read-only / low
  space → `problems[]`, slow drive → `slowDriveWarning`; never "bad hardware", never blocks). The
  drive-speed fn is **injected** in tests (deterministic, no real I/O, no network). Surfaced on Home via
  the `preflight:run` IPC (`registerCoreIpc`, preload `api.runPreflight`). **Encrypted-by-default kept:**
  the commercial first-run still lands on the existing `WorkspaceGate` (no plaintext offered when the
  policy forbids it); only the copy was softened for zero-technical-knowledge users.

- **GPU acceleration (Phases 14–16, 2026-06-10) — design record now `docs/architecture.md`
  "GPU acceleration — design record" (§1–§8):** Vulkan-first distribution +
  `cpu/` safety net + `.hilbertraum-runtime.json` install markers (§1/§4), the 4-rung start ladder +
  `--list-devices` probe (§5 — never pass `-ngl`; `--device none` is the only CPU-forcing
  mechanism), mid-generation crash auto-fallback over the `runtime:notice` channel (§5.3),
  E5 embedder pinned to CPU (§7), conservative profile bump via `gpuUsefulForProfile` (§8),
  Settings toggle + Diagnostics Acceleration/runtime-build/"Try GPU again" surface, and the
  `HILBERTRAUM_GPU_SMOKE` manual harness. New `AppSettings` keys: `gpuMode 'auto'|'off'` (default
  `'auto'`), `gpuAutoDisabled`, `gpuLastError`, `gpuProbe`.
- **GPU audit round (2026-06-10, post-Phase-16 — all findings remediated; commit `4549934`):**
  ① fetch-runtime upgrade bug (HIGH): re-fetching over an existing install never re-flattened
  the nested tarballs (old root binary survived under a fresh vulkan marker) — both scripts now
  pre-clean the extract dir (everything except the fresh archive + `cpu/`); ② sell gate
  hardened: binary required (not just a marker), backend verified natively, `extract_to`
  escape-guarded; ③ probe correctness: resolve on the child's `close` (not `exit`),
  `invalidate()` added, probe runs concurrently with the rung-1 start; ④ "Try GPU again" became
  a dedicated `gpu:try-again` IPC (clears flags AND invalidates AND re-probes; hidden while the
  Settings toggle is OFF); ⑤ `gpuProbe` refreshed once per session, not benchmark-only (a drive
  moved between machines kept the old GPU); ⑥ `looksIntegrated` broadened for real driver
  strings (RADV APUs, "AMD Radeon(TM) 780M", Meteor-Lake "Intel(R) Arc(TM) Graphics" — discrete
  Arc "A###" still bumps); ⑦ small: `gpuMode` enum-guarded, `fetch-runtime.ps1` pure ASCII,
  stale docstrings fixed.
- **Post-MVP UX polish round (2026-06-10)** — four user-reported issues, all behind existing
  contracts (tests in `chat-ipc`, `core-model-ipc`, `models`, `tests/renderer/ChatHomeNav`):
  1. **Conversation deletion:** `deleteConversation` (`chat:deleteConversation`) removes a
     conversation — chat AND documents mode — plus its messages (messages first; the FK has no
     CASCADE). Refused while a stream is in flight for that conversation (the persisted assistant
     turn would resurrect/FK-violate after the delete). UI: a ✕ per sidebar row with a confirm.
  2. **Persisted checksum cache:** the H5 in-memory cache died with the session, so the FIRST
     Models/Chat visit after every launch still re-hashed multi-GB GGUFs with no feedback. New
     `AppSettings.checksumCache` (`path → {size, mtimeMs, sha256}`, default `{}`) is the L2
     behind the in-memory L1 — `HashStore` is injected (`createSettingsHashStore(db)`) through
     `verifyChecksum`/`computeInstallState`/`buildModelList`, so an unchanged weight is hashed
     **once ever**; size/mtime changes re-hash. Living in settings (lastBenchmark precedent — no
     schema change) it is encrypted at rest on encrypted workspaces. **"Verify checksum" is now a
     true re-verify** via the new `verifyModel` IPC (`models:verify`): `invalidateChecksum`
     (memory + store) then a fresh `computeInstallState`. Models screen got a spinner +
     first-check copy; the accepted same-size/mtime-tamper limitation is recorded in
     `docs/known-limitations.md`.
  3. **Active-model auto-start:** a restarted app showed an "active" model whose runtime wasn't
     running. The `startRuntime` handler's §7.4 gate logic moved to an exported
     `startModelRuntime(ctx, modelId)`; new `maybeAutoStartActiveModel(ctx)` (mirrors
     `maybeRunFirstBenchmark` — background, never throws/blocks) fires at startup (plaintext dev)
     and after unlock/create (encrypted). Opt-out: `AppSettings.autoStartActiveModel` (default
     `true`) + a Settings toggle. ChatScreen's "no model" empty state now polls
     `getRuntimeStatus` every 2.5 s (and says the model may still be loading) so it flips to the
     composer by itself; its runtime check uses `getRuntimeStatus` instead of `listModels`
     (cheaper, no hashing).
  4. **Home navigation fix:** "Ask My Documents" used to land on the import screen. App.tsx now
     has a central `navigate()` with a virtual `'ask-documents'` target → Chat screen with
     `initialMode='documents'` (new optional `ChatScreen` prop); sidebar "Chat" resets to chat
     mode.
- **Post-MVP UX polish round 2 (2026-06-10):**
  1. **Chat output renders Markdown:** assistant replies (persisted AND the live streaming
     bubble) render GFM via **`react-markdown` + `remark-gfm`** (new RENDERER deps — pure JS,
     MIT, bundled by Vite into the renderer; NOT main-process/externalized). Safe by
     construction: react-markdown builds React elements (no `innerHTML`) and raw HTML in model
     output renders as **literal text** (renderer test proves no `<img>` injection). Links get
     `target="_blank"` → the existing window-open handler (http/https → OS browser, else deny).
     **User turns stay plain text** (`.msg-content` pre-wrap); assistant bubbles use
     `.msg-content.md` (white-space normal + scoped element styles in styles.css).
  2. **"Lock now" stops the sidecars:** `lockWorkspace` now aborts all in-flight generations
     (`inFlightStreams`), `Promise.allSettled`-stops the chat runtime AND the E5 embedder (a
     llama-server holds recent prompts in its KV cache), THEN `workspace.lock()` — a wedged
     sidecar never blocks the re-encrypt. Unlock restarts the chat runtime via the existing
     `maybeAutoStartActiveModel`; the embedder restarts lazily on next `embed()`.
- **Post-MVP UX polish round 3 (2026-06-10):**
  1. **RAM gate + RAM-best-fit recommendation:** `machineRamGb()` (totalmem, **whole-GB
     `Math.round`** so a "16 GB" machine reading 15.9 GiB still counts as 16) feeds
     `buildModelList` → new `ModelInfo.insufficientRam` (min RAM > machine RAM). UI: a
     "Needs ≥N GB RAM" badge + disabled Select/Start (§11.4 copy: "pick a smaller model —
     quality stays great"); MAIN gate: `startModelRuntime` refuses to load INSTALLED weights
     that don't fit (mock fallback ungated — uses no real RAM). **Recommendation is now
     RAM-best-fit** (`recommendModelIdByRam`): largest model whose `recommended_ram_gb` fits,
     else lightest meeting its minimum, else none — used by `listModels` AND the benchmark
     (same whole-GB rounding ⇒ the surfaces can never disagree); profile-table lookup stays
     as the no-RAM fallback. `AppStatus.machineRamGb` added (badge copy).
  2. **Read-only in-app document preview:** new `extractDocumentPreview` + `previewDocument`
     IPC (`docs:preview`) + a Documents-screen modal. RE-PARSES the stored copy (chunks
     overlap ~80 tokens — concatenating them duplicates boundary text); falls back to the
     original file if the copy is gone. Encrypted workspaces decrypt to a transient
     `.parse-preview` file shredded on the way out (the `.parse` infix keeps it under the
     startup crash sweep); without a cipher an `.enc` copy is refused. Deliberately TEXT-only
     (never `shell.openPath`): the original bytes must never reach an external viewer in
     plaintext. Tested: ingestion + encrypted-leak tests + renderer modal tests.
- **Post-MVP UX polish round 4 (2026-06-11) — two frontend issues:**
  1. **Password "Show" toggle → eye icon:** the password-reveal control in the shared
     `PasswordField` was a text "Show"/"Hide" Button; now an inline eye / eye-off SVG
     (`currentColor`, muted→full on hover, decorative `aria-hidden`). A11y
     preserved/improved: the Button keeps `aria-pressed` and carries a descriptive
     `aria-label`/`title` ("Show password"/"Hide password"). Test name-queries updated.
     (Merge note: the PR targeted the pre-Phase-32 copy inside `WorkspaceGate`; the change
     was ported to the extracted `renderer/components/PasswordField.tsx`, so the Unlock,
     first-run AND Settings → Change-password fields all get the icon.)
  2. **Filename auto-scope for document chat:** other documents were cited as sources when a
     question named one file, because document retrieval is **corpus-wide by default** —
     nothing parsed the question for a filename (the scope plumbing itself was correct
     end-to-end). New pure `detectFilenameScope(question, docs)` (`services/rag/scope.ts`,
     unit-tested) matches a file by its title/stem as a whole-token run (token-boundary, lone
     generic words ignored, whole-corpus match = no match). `askDocuments` applies it **only**
     when the conversation has no explicit "ask selected documents" scope, as the per-request
     `scopeDocumentIds` — narrows only, never widens; explicit scope always wins. Visible +
     honest: a one-shot non-persisted `STREAM.scope` notice (`api.onScopeNotice`) → an
     *"Answering from contract.pdf only"* toast in Chat. Tests: `tests/unit/rag-scope.test.ts`
     + a `tests/integration/rag.test.ts` case proving unscoped surfaces both docs while the
     detected scope returns only the named file. Design record: `docs/rag-design.md` §10.
- **Doc lifecycle: finished plans become design records (2026-06-10):** implemented plan docs
  are condensed to short design records (decisions + load-bearing facts + the design as built)
  or deleted, with the full original in git history — finished plans otherwise drift and
  contradict code (the GPU audit proved it). Applied: `docs/IMPLEMENTATION_PLAN.md` **deleted**
  (per-phase ritual lives in CLAUDE.md; spec-§22 Definition of Done folded into §5; the dead
  Phase-0 `PlaceholderScreen.tsx` went with it); `docs/gpu-support-plan.md` and
  `docs/provisioning-and-distribution-plan.md` **condensed** with their cited section anchors
  kept stable (gpu §1–§8; provisioning §0/§12/§12.3/§13). In the 2026-06-12 housekeeping both
  were folded onward and deleted: provisioning → `docs/packaging.md`; the GPU record →
  `docs/architecture.md` "GPU acceleration — design record" (§-anchors preserved). Rule recorded in
  CLAUDE.md ("Doc lifecycle rule"). Full originals: `git show 4549934:docs/<file>`. **Also applied at
  wave-1 closeout (2026-06-10): `docs/post-mvp-functionality-plan.md` condensed** to the
  wave-1 design record (full original: `git show 2a46ca3:docs/post-mvp-functionality-plan.md`);
  in the 2026-06-12 housekeeping that record — and `docs/retrieval-quality-plan.md` +
  `docs/model-catalog-expansion-plan.md` — were folded into the topic docs (rag-design §10/§12,
  architecture, model-benchmarks §7, model-policy) and deleted.
- **Functionality wave 1 — Phases 17–20 (2026-06-10) — design record folded into the topic
  docs (full original: `git show 2a46ca3:docs/post-mvp-functionality-plan.md`):**
  **Phase 17** RAG trust & document-scoped asking (`docs/rag-design.md` §10 incl. D1/D2 —
  ask-selected-documents scope, plain-chat document-awareness notice, vector-tag fix,
  reindex-needed answer). **Phase 18** in-app model downloader (`docs/architecture.md`
  "In-app model downloader" incl. D3 — triple-gated:
  policy ∧ default-off setting ∧ per-download confirmation; `.part` + verify-before-rename,
  Range resume, async-with-polling IPC). **Phase 19** audit log on `runtime_events`
  (`docs/architecture.md` "Audit log" incl. D7
  + `docs/security-model.md` — never-throws recorder with locked-vault buffering, hard
  privacy rule ids/filenames/counts never content (sentinel-grep-tested), 5 000-row
  prune-on-insert, Diagnostics Activity panel + export). **Phase 20** answer-depth modes
  (`docs/architecture.md` "Chat & streaming" incl. D4–D6 — per-request
  `chat_template_kwargs.enable_thinking`,
  the ADDITIVE `chat:reasoning:<id>` stream channel, reasoning stripped from persistence;
  the `--reasoning auto` silent-delta research finding and the `CHAT_SERVER_ARGS` pin are
  recorded there).
- **Phase 21 — retrieval quality: reranker + hybrid keyword search (2026-06-10) — design
  record `docs/rag-design.md` §12 (decisions
  D8–D15 + research facts, incl. the rerank-mode `n_ubatch=512` HTTP-500 trap and its
  batch-size fix, §12.1 R1) + §11 (as built):** FTS5 keyword pass + RRF
  fusion in `retrieve()`; optional CPU-pinned `bge-reranker-v2-m3` sidecar behind a
  `Reranker` interface whose absent default keeps retrieval byte-identical. Real-hardware
  smokes on `D:\` (i7-1185G7): F16 loads on b9585, relevance correct, worst-case
  12-candidate batch ≈ 24.7 s CPU; `ragMinSimilarity` measured → stays 0 (§12.1 R3 —
  prefix-less E5 compresses all cosines into ~0.87–0.94, separation is the reranker's job);
  the `HILBERTRAUM_RAG_QUALITY` end-to-end run validated the reranker rescuing the true clause
  from #3-behind-distractors to #1 (the concrete justification for its ~25 s worst case).
- **UI polish wave — Phases 23–27 (2026-06-10, branch `ui-phase-23-tokens-theming`, merged
  to master same day) — durable reference [`docs/design-guidelines.md`](docs/design-guidelines.md)
  (ADOPTED), rollout record + decisions D-UI1–4 + the eyeball-walk verification pattern in
  its §11:** Phase 23 tokens + theming (additive `AppSettings.theme`; the gate always follows
  the OS theme, D-UI2) · 24 shared component layer on four pinned, license-reviewed Radix
  primitives (D-UI1) · 25 chat restructure per guidelines §3 (the wave's priority) · 26 IA
  regroup nav 7→5 + Privacy/Diagnostics as Settings tabs (legacy `privacy`/`diagnostics` nav
  aliases kept working; Home stays as the readiness hub, D-UI3) · 27 copy sweep + the
  "Local · Offline" ambient indicator + the 3-step first-run create flow + the WCAG 2.2 AA
  sweep (accepted items and the bundled-app `WrongPasswordError` instanceof/tree-shake quirk
  are recorded in `docs/known-limitations.md`).
- **Phases 28–29 — model catalog wave 1 + benchmark (2026-06-10/11) — design record
  [`docs/model-benchmarks.md`](docs/model-benchmarks.md) §7 (D16–D22) + its §0–§6
  (protocol, tooling, first-run
  results) + `docs/model-policy.md` (catalog table, license reviews, recommendation,
  disqualified candidates):**
  four Apache-2.0 challenger manifests landed with vendor-verified sources and real hashes
  (all 10 catalog weights VERIFIED on `D:\`; bring-up smokes PASS on real b9585). The
  judge-free benchmark (scorer `tests/eval/score.ts`, harness `tests/manual/model-eval.test.ts`,
  100-item `eval/{corpus,rag}_de_en.jsonl`) ran on the i7-1185G7 for all 8 models (QA
  reproduced bit-for-bit on the dev box). Applied live: `recommended_min_ram_gb` recalibrated
  from measured peak RSS, the recommender made quality-aware via the new `recommendation_rank`
  manifest field (≤12 GB → Qwen3-4B / 16 GB → Ministral / ≥32 GB → Gemma 4; Granite + 30B
  never auto-recommended), Gemma's `supports_thinking_mode` flipped ON after its thinking
  check. Headline discriminator: hallucination resistance on unanswerables (Ministral 0/15
  best); grounded EM saturates (~96–98 %) — the D27 eval-hardening motivation. Only the
  optional dev-box speed sweep remains (QA + RSS are machine-independent).
- **Functionality wave 3 — Phases 31–38 (2026-06-11) — design record
  [`docs/architecture.md`](docs/architecture.md) "Functionality wave 3 — design record"
  (decisions D23–D37 in §13, research-gate findings banked in §14, plus the §-anchor legend
  mapping the retired plan's per-phase §4–§11 to their topic-doc homes):**
  **31** conversation search (`messages_fts` mirroring the D13 index shape, bm25 ranking,
  `chat:search`, ConversationList search UI; + the deny-by-default
  `setPermissionRequestHandler` session-hardening rider) · **32** vault password change
  (descriptor v2 envelope with a wrapped data key — new vaults v2, O(1) re-wrap per change
  with a free scrypt→argon2id upgrade, one-time journaled v1→v2 migration on first change
  with crash-cut recovery tests, `workspace:changePassword` + Settings card, import↔change
  race guard) · **33** document-task engine + one-click summary (`DocTaskManager` queue/
  cancel/polling reused by 34–35; strict one-at-a-time vs chat both ways; budgeted map-reduce
  summary in `documents.summary_json`; R-T1: b9585 serves concurrent requests on PARALLEL
  slots — the app-side guard is the only serialization) · **34** translation (re-extracted
  parser segments, never the overlapping chunks — D36; R-T2-measured window math, German out
  ≈ 2.0 tok/word; retry-once-then-mark; materialized corpus document under the Phase-32
  lease + `documents.origin_json` provenance; new `docs:export`) · **35** compare two
  documents (auto mode-switch by token math — D37 segments for input AND decision;
  section-matched mode pairs windows via the existing `VectorIndex`, deterministic, ceiling
  12 with an honest in-report notice; embedder-visibility guard fails friendly before any
  model call; two smoke rounds hardened the prompts against silent per-pair omission) ·
  **36** audio transcription as ingestion (whisper.cpp **v1.8.6** as the SECOND sidecar
  family — `whisper_cpp:` yaml block, `fetch-runtime --family`, commercial gates; the
  `whisper-small-multilingual` manifest, `role: transcriber`, covered by the Phase-18
  downloader with zero new code; `services/transcriber/` + `AudioParser` packing
  time-labeled segments → `"mm:ss–mm:ss"` citations, 1 chunk = 1 segment; D35 = keep the
  audio copy, re-index = re-transcription; the runtime↔format pair matrix in
  `computeInstallState` and the `selectModel` non-chat-role refusal shipped with it) ·
  **37** voice dictation (renderer MediaRecorder → 16 kHz mono WAV → `dictation:transcribe`
  → transient `.parse-dictation.wav`, shredded in `finally` → insert-at-cursor, NEVER
  auto-sent; the single scoped audio-only own-WebContents `media` permission allow;
  availability-driven `AppStatus.dictationAvailable`) · **38** scanned-PDF / photo OCR
  (R-O1 SPLIT design: hidden-window pdfjs-LEGACY rasterization behind a pull-based
  `OCR_RASTER` protocol + MAIN-side tesseract.js **Node mode** on Buffers, pinned 7.0.0 +
  `asarUnpack`; R-O3 → **best_int** traineddata (float `tessdata_best` crashes the WASM
  core); step-0 scan detection with friendly copy; D33 "Make searchable (OCR)" task →
  `documents.ocr_json` → re-ingest via the PdfParser `ocrPages` hook ⇒ page citations
  unchanged; photos OCR on import; `ocr:` asset class + `fetch-runtime --family ocr` +
  commercial gates; `AppStatus.ocrAvailable`). Wave close: **968/968 tests green** (+25
  `HILBERTRAUM_*` manual skips), `HILBERTRAUM_OCR_SMOKE` + built-app eyeball walks PASSED on real assets.
- **Docs-vs-code audit + comment quality pass (2026-06-13):** a full systematic comparison of
  every doc against `apps/desktop/src` (8 parallel read-only audits, findings re-verified before
  changes) found the docs largely accurate; the real doc bugs fixed were: a never-shipped TINY
  warning string in `benchmark.md`, the user-guide's "all chat models support Thorough" claim
  (Ministral/Granite/2507 don't), troubleshooting's pre-Phase-38 "OCR is not included", stale
  §4 contract lines here (DEFAULT_KDF, `selectModel` return, AuditEventType count), and the
  architecture "Data flow" pipeline that predated hybrid retrieval. A **comments-only quality
  pass** over all of `apps/desktop/src` (~100 files) trimmed history/provenance narration
  (Phase/D/R/H/M ids, audit stories) while keeping every LOCKED/security/platform constraint;
  verified mechanically — esbuild-stripped output of every changed file is byte-identical to
  the pre-pass HEAD. Dead-info pass: resolved `~~strikethrough~~` entries deleted from
  `known-limitations.md`; dangling §-references to retired plan files repointed
  (model-benchmarks, security-model, rag-design); future-tense "lands in Phase N" rewritten as
  shipped behavior. The test-infra nuisance noted here (1–2 timeout flakes under the FULL
  parallel suite on a loaded machine) was mitigated in the remediation entry below.
- **Audit-findings remediation (2026-06-13):** the code findings banked by the audit are
  fixed (commits "Audit fix A/B/C"). A — user-visible strings: phase jargon retired from the
  mock-runtime reply, the DiagnosticsTab fallbacks, and the commercial-drive step
  descriptions; the doctasks materialize-failure log is kind-aware. B — robustness: orphaned
  `OCR_RASTER.error` frames are logged; the E5 embedder gained the reranker's failed-start
  latch with ONE deliberate difference — it **clears on `suspend()`** (the embedder has no
  graceful degradation, so replace-the-GGUF + lock/unlock must make imports retryable;
  architecture.md updated); `plaintextAllowed` is now honestly `(policy, { isDev })` — the
  old `developerMode` parameter was always fed `isDev` (the proxy rule is documented;
  `encryptionRequired` stays the absolute veto; security-model.md updated); `ensureColumn`
  asserts identifier/DDL shape before interpolating; downloads detect a cancel race via the
  AbortSignal (cast removed) and prune terminal jobs beyond the most recent 20; preflight
  selects the slow-drive warning by content, not `[0]`; `rag.retrieve` joins fused candidates
  in one `IN (…)` query (placeholders, fused order preserved); `RUNTIME_POLL_MS` is shared
  (`renderer/lib/polling.ts`); the triplicated export save-dialog step is one helper
  (`ipc/save-export.ts` — audit calls stay per-site, per the privacy rule); the runtime
  status `'cpu'` fallback is a named default (`UNLABELLED_BACKEND`). C — test infra: the
  parallel-suite timeout flakes were CPU starvation tripping vitest's 5 s default, so
  `testTimeout: 15_000` (3× headroom) in `vitest.config.ts` — chosen over capping
  `maxWorkers` because it leaves a clean run's wall time unchanged. Suite: **969 tests
  green** (968 + the new e5 failed-start-latch test).
- **Multi-persona audit + MEDIUM remediation (2026-06-13, branch `audit-2026-06-13-high-fixes`,
  NOT yet merged):** a fresh five-persona audit (`docs/audit-2026-06-13.md`, a working report
  outside the doc-lifecycle rule). No CRITICAL. **Round 1** fixed the 4 code HIGHs + M-S3 (H1
  import lease-leak, H2 RAG token budget ×1.3, H3 truncated-blob guard, H4 OCR rasterizer
  busy-flag, M-S3 OCR-window nav guards). **Round 2** added the H5/M-A1 drift test
  (`tests/integration/script-drift.test.ts`) + the M-D1/2/3 stale-doc fixes. **Round 3** banked
  the prioritized MEDIUMs: M-C1/2/3 sidecar lifecycle (a post-ready `'error'` without `'exit'`
  now fires the GPU crash auto-fallback **and** resolves `stop()`; `stop()` escalates to SIGKILL
  even when `child.kill()` throws; the auto-fallback re-arms on a synchronous `restart()` throw —
  the fix surfaced a secondary bug: `stop()` clears `ready`, so the `'error'` handler must record
  the exit during teardown too or the SIGKILL escalation double-fires `kill()`); M-C4 RRF
  tiebreak on best-rank-across-both-lists (exact-term keyword-only hits no longer suppressed);
  M-C5 caller abort signal plumbed `retrieve → embed/rerank` via a shared `combineSignals`
  (`runtime/sidecar.ts`); M-S2 per-handler IPC arg-shape guards (`createWorkspace` `password.length`
  TypeError + unlock/changePassword/importDocuments); M-S1 offline guard kept **detection-only by
  decision** (`security-model.md` §2 "Detection-only, not enforcement" — enforcing via the
  process-wide `net.Socket.connect` shim would turn a host-extraction edge case into a hard offline
  failure breaking loopback IPC/sidecar; the guarantee rests on the no-remote-code posture + the
  prod CSP). **Round 4** banked the a11y trio + the M-A1 follow-up: L8 (composer `aria-label`
  mirroring the mode prompt), M-U1 (new `ErrorBanner` — an always-mounted `role="alert"`
  `display:contents` wrapper that swaps text; Banner took a `role` override so the inner one is
  `status` not a nested alert; chat/documents/models error banners migrated), L7 (the visible
  streaming markdown is no longer a live region — a separate `.sr-only` `StreamAnnouncer` announces
  only newly-completed sentences, markdown-stripped, resetting per stream), and M-A1 **completed**
  (drift test extended to the `config/{drive,policy}.json` payloads vs `buildDriveJson`/`buildPolicyJson`
  for both editions, plus the `verify-models.{ps1,sh}` sha256 regex vs `isRealSha256` and the
  runtime/format gate vs the now-exported `SUPPORTED_RUNTIMES`/`SUPPORTED_FORMATS`). Suite **1043 green**,
  typecheck + build clean. **Round 5** banked the remaining LOWs (except L16–L19). Correctness: L2
  (`cosineSimilarity` throws `RangeError` on a length mismatch — the only caller dimension-guards first,
  so a mismatch is a real bug not a prefix to score); L3 (E5 batch reorder handles all-indexed → sort,
  none-indexed → trust array order, and **throws** on a partial mix that would silently misalign
  vectors↔chunks); L4 (embedder `suspend()` clears the failed-start latch **after** teardown — teardown
  awaits an in-flight start, so a racing failure during it would otherwise re-arm the latch and force a
  second lock/unlock); L5 (transcriber `suspend()`/`stop()` track each child against a promise that
  resolves only after its transient-transcript shred runs, then **await** them — the parent can no longer
  exit on quit leaving an un-shredded transcript in `tmpdir()`, which the workspace crash-sweep never
  reaches); L6 (`parseCitations`/`isCitation` validate the `citations_json` shape on read, mirroring
  `parseScope`). a11y: L1 (markdown `a` renderer whitelists http(s), else inert text); L9 (`docs` literal
  → single `home.preflight.continue` key with a `{folder}` placeholder the UI splits to bold); L10
  (`friendlyIpcError` at the remaining `String(e)` sites in Chat/Documents/Models screens); L11
  (`<Spinner>` with `aria-hidden` baked in, replacing every bare `.spinner` span); L12 (`aria-describedby`
  on the ConfirmDialog body via `useId`); L13 (strength meter is no longer a `role="status"` live region —
  a separate debounced `.sr-only` region announces the word only after typing settles); L14
  (search-results `aria-live="polite"` + an `.sr-only` count); L15 (Thinking `<button aria-expanded>`
  instead of a `preventDefault`-driven `<details>`, reasoning kept mounted-but-`hidden` when collapsed).
  Suite **1058 green**, typecheck + build clean. **Round 6 — batch 1 (branch
  `audit-2026-06-13-high-fixes`):** the deps/test-gap LOWs + one locale MEDIUM. L17 (`logging.ts` had
  zero tests — added `tests/unit/logging.test.ts`: MAX_BYTES rotation, circular-meta non-throw,
  `readLogTail`); L18 (`@napi-rs/canvas` native `.node` excluded from app.asar via a `!**/@napi-rs/
  canvas*/**` `files` glob in `electron-builder.yml` + `tests/integration/packaging.test.ts` asserting
  it); L19 (captured the real **b9585** `--list-devices` stdout into `tests/fixtures/` — CRLF kept
  binary — and parse it as a `gpu.test.ts` regression); L16 (extracted `resolveSidecarSelection` in
  `services/select-sidecar-backed.ts` — the shared model→binary→weights ladder behind the three
  sidecar factories); M-U5 (tech-disclosure GB / Diagnostics MB-s + tokens-s / Settings context-tokens
  now route through locale `toLocaleString` helpers). Suite **1070 green**, typecheck + build clean.
  **Round 6 — batch 2 (branch `audit-2026-06-13-high-fixes`):** the UX + architecture MEDIUMs, closing
  the audit. UX: M-U2 (a stopped chat stream now toasts `chat.stopped` — a truncated reply is no longer
  mistaken for a complete one); M-U3 (the no-model chat state routed through the shared `EmptyState`);
  M-U4 (offline state lifted to App as the single ambient truth — the chat header `LocalIndicator` takes
  it as a prop instead of self-fetching, so it can't disagree with the sidebar); M-U6 (`Re-index all
  stale` gated behind a `ConfirmDialog` + a determinate `Progress` bar). Architecture: M-A2
  (`ipc/chat-stream.ts` — `assertChatStreamReady` + `withChatStream` collapse the duplicated guard
  preamble + stream lifecycle that registerChatIpc/registerRagIpc kept in hand-synced lockstep); M-A3
  (`resolveModelByRole` + `composeServices` extracted from `initBackend`); M-A4 (the 1582-line
  `doctasks.ts` split into `doctasks/{summary,translation,compare,manager}.ts` behind a byte-identical
  re-export barrel); M-A5 (the `HILBERTRAUM_*` manual-harness matrix documented as a required pre-release gate
  in `packaging.md` + the canned-real-output regression-fixture policy). **The 2026-06-13 audit is now
  fully remediated** (every HIGH, MEDIUM, and LOW closed; the `docs/audit-2026-06-13.md` working report
  was deleted per its own lifecycle rule — the full annotated report, incl. the "Confirmed NON-issues"
  list of accepted limitations, stays recoverable from git history). Suite **1083 green**, typecheck +
  build clean.
- **D1 re-affirmed — unified auto-RAG chat stays NOT built (2026-06-12):** the Phase-21 data
  the original deferral waited for is in, and it argues AGAINST unifying now: no cheap
  relevance gate exists under prefix-less E5 (the measured-floor overlap, rag-design �12.1
  R3), the reranker gate is optional equipment at up to ~25 s worst-case CPU per message, and
  the wrong-tab failure is already triple-defended (awareness notice, mode subtitles,
  filename auto-scope). **Revisit trigger = Phase 30 Track B** (a prefix-using embedder with
  a measurable floor) — rider recorded in `big-slot-embeddings-plan.md` �4.4; full
  rationale in `rag-design.md` �10 (D1).

- **Phase 39 — i18n foundation + proof slice (2026-06-13; condensed record:
  `architecture.md` "Internationalization — design record"; full original plan
  `git show 5059ed8:docs/i18n-plan.md` §4):** hand-rolled typed i18n in `shared/i18n/` — `en.ts` flat
  source-of-truth catalog (`MessageKey = keyof typeof en`), `de.ts` typed
  `Record<MessageKey, string>` so **typecheck enforces catalog parity**, `t`/`tCount`
  (`.one`/`.other`, n === 1 rule)/`resolveUiLanguage` — synchronous, **zero new deps**
  (D-L1 LOCKED). New `AppSettings.uiLanguage: 'system'|'en'|'de'` (default `'system'`,
  theme-style enum guard; D-L2 LOCKED) + a Settings → General SegmentedControl picker
  (System/English/Deutsch — language names untranslated). Renderer `renderer/i18n.tsx`
  `I18nProvider`/`useT()`: re-resolves on settings load/patch, sets `<html lang>`, mirrors
  the RESOLVED language to `localStorage('hilbertraum.uiLanguage')`; the pre-unlock gate resolves
  mirror → `navigator.language` (D-L3 LOCKED). Main `services/i18n.ts`: cached language
  from `app.getLocale()` (set after whenReady), re-resolved at plaintext startup, after
  unlock/create, and on `uiLanguage` patches; `tMain()` localizes ephemeral emissions —
  first use = the gate's wrong-password message, English byte-identical (D-L5 LOCKED).
  Proof slice migrated: App shell (nav/lock/notice chrome), SettingsScreen (tabs + General
  tab fully), WorkspaceGate (all steps); German copy is informal „du" (D-L7) with the §3.5
  glossary pinned atop `de.ts`. **R-L1 finding:** on this de-AT Windows 11 machine
  `app.getLocale()` returns the BARE tag `'de'` (not `de-*`) and `navigator.language`
  matches — `resolveUiLanguage` accepts bare `'de'`; the dev machine is German-locale
  (not EN as the plan assumed), but the suite is locale-independent (jsdom pins
  `navigator.language` to `en-US`). Tests: 990 green from `apps/desktop`; new
  `tests/unit/i18n.test.ts`, `tests/unit/main-i18n.test.ts`, `tests/renderer/I18n.test.tsx`
  (picker patch + mirror + German gate smoke); one scoping edit in `Theme.test.tsx` (the
  General tab now has two "System" radios — scope by radiogroup, don't rename). Persisted
  DB strings and LLM prompts untouched (D-L4/D-L6 wait for Phases 41/42).
- **Phase 40 — i18n renderer string sweep (2026-06-13; sweep conventions kept as
  `architecture.md` i18n record §5; grep-audit result in the original plan §5,
  `git show 5059ed8:docs/i18n-plan.md`):** every remaining renderer screen/component migrated to the
  shared catalogs in five batch commits (① Home + chat components + App leftovers ②
  Documents ③ Models ④ Privacy/Diagnostics tabs ⑤ shared components), catalogs now
  ~440 keys/language with **English values byte-identical** (D-L8 — the pre-existing
  role+name assertions passed unchanged). Label maps kept their structure with
  `labelKey: MessageKey` values (`STATUS_BADGE`, `STATE_BADGE`, `AUDIT_TYPE_LABELS`,
  `TASK_BUSY_*`, `DEPTH_LABEL_KEYS`, `ConversationGroup.labelKey`); hand-rolled plurals
  → `tCount`; the two `toLocale*String()` date sites + file-size/RAM formatting take the
  resolved locale from `useT().lang` (`useGrouping: false` keeps EN output identical).
  **Shared components RECEIVE a bound `t` prop/argument** (`components/translator.ts`:
  `Translator` type + `englishTranslator` default for provider-less tests) — Banner
  Dismiss, Modal Close, ConfirmDialog Cancel, Chip Remove, PasswordField Show/Hide +
  strength `labelKey`/`hintKey`, LocalIndicator label/detail. Phase-41 boundary
  untouched: persisted `documents.error_message` renders as-is, `DOC_TASK_BUSY_MESSAGE`
  recognition unchanged, raw IPC/job/audit error strings pass through;
  `MIC_BLOCKED_MESSAGE` stays canonical in `lib/dictation.ts` and is exact-matched +
  localized at display in `DictationButton`. Untranslated by design: product name/"Lite",
  picker language names, technical ids/paths. Tests: 997 green from `apps/desktop`; new
  `tests/renderer/GermanSmoke.test.tsx` (German render smoke per migrated screen + the
  shared-component built-ins); grep audit clean (remaining capitalized literals =
  comments, dev-internal throws, `e.key` names — recorded in plan §5).
- **Phase 41 — i18n main-process boundary (2026-06-13; condensed as `architecture.md`
  i18n record §3.3; fact-5 classification findings in the original plan §6,
  `git show 5059ed8:docs/i18n-plan.md`; D-L4 LOCKED):** the §3.3 two-rule
  boundary applied across the main process in four step commits. **Rule 1 (persist
  canonical, LOCKED D-L4):** everything written to the DB / settings stays canonical
  English via explicit `t('en', …)` + a §3.3 comment — the 7 parser-failure constants
  (`scanDetected` exact-match contract untouched), source-missing + reconcile messages,
  `NO_DOCUMENT_CONTEXT_ANSWER` **and `REINDEX_NEEDED_ANSWER`** (fact-5 correction:
  also persisted into `messages.content`), `DOC_TASK_BUSY_MESSAGE` (canonical ON THE
  WIRE — ChatScreen's `error.includes` recognition), and `buildWarnings` (persisted in
  `settings.lastBenchmark`). The renderer translates them at display via the new
  exact-match **display map** (`renderer/lib/displayMap.ts`, `localizeServerCopy`) in
  DocumentsScreen failure rows, Transcript (persisted + live bubble), the ChatScreen
  banner (busy-message substring case), DiagnosticsTab warnings, and Home preflight
  notes; unknown strings (raw library errors, the interpolated `Unsupported file
  type: …`) render as-is — accepted. Old pre-i18n rows re-translate retroactively on a
  language switch (byte-identical English, D-L8). **Rule 2 (emit localized, D-L5):**
  `tMain()` at every emission site — doc-task guards/status errors (**verified
  in-memory only**, never persisted), download refusals + job errors, the IPC guards
  (docs/chat/rag/doctasks/models/downloads), preview/export throws, preflight problems
  (transient; the slow-drive note stays canonical — shared with persisted benchmark
  warnings — and is display-mapped), the GPU compatibility-mode notice, the remaining
  workspace gate/change-password results, the `VaultBusyError` lease message, and the
  five native dialog titles + picker filters (window title stays the product name).
  `FRIENDLY_TASK_ERRORS` became the exported `isFriendlyTaskError()` checking both
  catalogs (guard throws are now localized). Audit-log messages stay English in DB +
  export (privacy rule, accepted); LLM prompts untouched (D-L6). Tests: full suite
  **1007 green**; new `tests/integration/i18n-boundary.test.ts` +
  `tests/unit/display-map.test.ts`; built bundle launch-smoked on this de-AT machine
  (German home, German no-model IPC refusal in vivo).
- **Phase 42 — i18n German QA + closeout (2026-06-13) ⇒ i18n wave (39–42) COMPLETE;
  plan condensed to `architecture.md` "Internationalization — design record" +
  `design-guidelines.md` §7 "German microcopy" and DELETED
  (`git show 5059ed8:docs/i18n-plan.md`); ~51 code comments retargeted from
  "i18n-plan §" to "i18n record §" (§-numbers preserved):**
  ① full `de.ts` review pass — 9 value fixes (imperative consistency prüfe→prüf,
  Mock→Demo-Runtime, grammar/idiom fixes; commit `a4d91de`), the user holds the final
  D-L7 human-review pass. ② German eyeball walk (`%TEMP%\hilbertraum-eyeball\walk-phase42.mjs`,
  shots in `shots-p42`): encrypted first-run gate flow + every screen at BOTH window
  extremes (880×600 / 1920×1040) with a programmatic overflow scan, plus an English
  regression leg via the picker. Three text-expansion findings, all fixed with LAYOUT:
  `.chat-header` wraps (the German mode label + ambient indicator clipped at 880),
  chat empty-state example chips wrap instead of ellipsizing at the 240px chip cap,
  `.kv dd` uses `overflow-wrap: anywhere` (break-all cut German words mid-word).
  ③ Untranslated-string finding fixed: the persisted default conversation title
  `'New chat'` is persist-canonical with a behavioral exact-match
  (`maybeSetTitleFromFirstMessage`) ⇒ new `main.chat.defaultTitle` key (persist-canonical
  section), `DEFAULT_TITLE = t('en', …)`, display-map entry, `ConversationList` passes
  titles through `localizeServerCopy` (real user titles pass through). ④ Catalog hygiene
  tests extended: plural-pair completeness + `DISPLAY_MAP_KEYS` ↔ persist-canonical
  section pinned key-for-key (`display-map.test.ts`). ⑤ **All seven acceptance criteria
  verified explicitly:** (1) instant System/English/Deutsch switch + `<html lang>` in
  vivo; (2) German gate/first-run/post-unlock with zero stored state in vivo (cleared
  localStorage + reload); (3) no English remnant in the German walk (product
  name/technical values excepted — the one finding was ③, fixed); (4) scanned-PDF under
  German UI: scanDetected intact, German failure row, OCR offer present, same row
  canonical English after switching (display map works both ways); (5) wrong-password +
  no-model refusals German in vivo, download/policy refusal copy pinned by
  main-i18n/boundary tests; (6) suite 1010 green + typecheck green, removing a de.ts key
  ⇒ TS2741 (demonstrated); (7) zero new deps / no network / audit-log untouched (phase
  diff inspected). ⑥ `known-limitations.md` "Internationalization" section added (D-L6
  documented ⇒ RESOLVED; audit-log English; interpolated/library errors render as-is;
  user-guide/README English-only for now; mixed-language transcripts accepted).

---

## 4. Shared data contracts (the actual "transported data")

> Source of truth for cross-module/cross-phase types. Keep in sync with `apps/desktop/src/shared/`.
> Phases append/refine here so later phases know the exact shapes.

### IPC command surface (spec §9.1) — target
```ts
getAppStatus(): Promise<AppStatus>
getDriveStatus(): Promise<DriveStatus>
runBenchmark(): Promise<BenchmarkResult>
listModels(): Promise<ModelInfo[]>
selectModel(modelId: string): Promise<{ activeModelId; activeEmbeddingModelId }>
startRuntime(modelId: string): Promise<RuntimeStatus>
stopRuntime(): Promise<void>
createConversation(): Promise<Conversation>
sendChatMessage(conversationId, message, options): stream → events
askDocuments(conversationId, question): stream → events
importDocuments(paths: string[]): Promise<ImportJob>
getImportJob(jobId: string): Promise<ImportJobStatus>
listDocuments(): Promise<DocumentInfo[]>
deleteDocument(documentId: string): Promise<void>
getSettings(): Promise<AppSettings>
updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
```
_Status: TypeScript types in `apps/desktop/src/shared/types.ts`; channel names in `src/shared/ipc.ts`.
Wired so far: core (Phase 1) + `listModels`/`selectModel`/`startRuntime`/`stopRuntime` (Phase 2) +
`createConversation`/`listConversations`/`listMessages`/`sendChatMessage`/`stopGeneration` (Phase 3) +
`pickDocuments`/`importDocuments`/`getImportJob`/`listDocuments`/`deleteDocument`/`reindexDocument`
(Phase 4) + `askDocuments` (Phase 6) + `runBenchmark` (Phase 7) + `getPolicy` (Phase 8) +
`getWorkspaceState`/`unlockWorkspace`/`createWorkspace`/`lockWorkspace` (Phase 9) +
`runPreflight` (Phase 13) + `getRuntimeStatus`/`exportConversation`/`getLogTail` (audit round 4 —
spec §7.6 export + §7.11 Diagnostics) + `getRuntimeInstall` (`runtime:install`, Phase 16) +
`tryGpuAgain` (`gpu:try-again`, GPU audit round) + the `runtime:notice` main→renderer event
channel (Phase 15, `EVENTS.runtimeNotice`, preload `onRuntimeNotice`) +
`deleteConversation` (`chat:deleteConversation`), `verifyModel` (`models:verify`) and
`previewDocument` (`docs:preview`) from the post-MVP UX polish rounds +
`updateConversationScope` (`chat:updateScope`, Phase 17 — replace/clear a documents
conversation's "ask selected documents" scope) +
`downloadModel`/`getDownloadJob`/`cancelDownload` (`downloads:start/get/cancel`, Phase 18 —
the in-app model downloader, async-with-polling) +
`getAuditEvents(limit?, beforeId?)`/`exportAuditLog` (`audit:list`/`audit:export`, Phase 19 —
the Diagnostics Activity panel, newest-first paging + save-dialog export) +
`searchConversations` (`chat:search`, Phase 31) + `changeWorkspacePassword`
(`workspace:changePassword`, Phase 32) +
`startDocTask`/`getDocTask`/`cancelDocTask` (`doctasks:start/get/cancel`, Phases 33–35 —
document tasks, async-with-polling; `cancelDocTask()` with no jobId cancels the active task;
shapes `StartDocTaskRequest`/`DocTaskStatus`/`DocumentSummary` in `shared/types.ts`, and
`DocumentInfo` gained an optional `summary` from the additive `documents.summary_json` column;
Phase 34: `kind: 'translation'` takes `params.targetLang: TranslationTargetLang ('de'|'en')`,
`resultRef.documentId` = the NEW materialized document, and `DocumentInfo` gained an optional
`origin: DocumentOrigin` from the additive `documents.origin_json` column;
Phase 35: `kind: 'compare'` takes exactly TWO distinct `documentIds` and `DocumentOrigin` is
now a discriminated union — `{ type: 'translation', translatedFrom, targetLang }` |
`{ type: 'compare', comparedFrom: [a, b] }`; Phase-34 rows persisted without `type` parse as
`'translation'`, an additive migration) +
`exportDocument` (`docs:export`, Phase 34 — save-dialog export of a text document's stored
content, the `exportConversation` pattern; resolves with the path or null on cancel) +
`importPreflight` (`docs:importPreflight`, Phase 36 — read-only selection summary driving the
large-audio import confirm; `DocumentInfo` gained optional `transcriptionProgress`) +
`transcribeDictation(audio: Uint8Array): Promise<string>` (`dictation:transcribe`, Phase 37 —
voice dictation: 16 kHz mono WAV bytes in, plain text out; request/response, nothing persisted,
no audit; `AppStatus` gained the additive `dictationAvailable: boolean` gate).
Phase 38: `kind: 'ocr'` on the same doc-task channels (one PDF; the target must be
scan-detected or already OCR'd; needs the OCR engine, not the chat runtime);
`DocumentInfo` gained the DERIVED `scanDetected` flag + optional `ocr: DocumentOcrInfo`
(metadata of the additive `documents.ocr_json` column — the recognized text itself is
content and never leaves the DB); `AppStatus` gained the additive
`ocrAvailable: boolean` gate. The internal `OCR_RASTER` channels (shared/ipc.ts) bind
ONLY the hidden rasterizer window's preload, never the app bridge.
(`pickDocuments` + `reindexDocument` are Phase-4 additions to the `IPC` registry beyond the spec
§9.1 list — picker + re-index UX; `getPolicy` is a Phase-8 addition; the four `workspace:*` channels
are Phase-9 additions.) `createConversation` now also accepts an optional `mode`
('chat' | 'documents') and an optional `scopeDocumentIds` (Phase 17); `Conversation` carries
`scopeDocumentIds: string[] | null` (additive `conversations.scope_json` column, guarded
ALTER-TABLE migration in `db.ts`)._

### DB schema
✅ Implemented in `src/main/services/db.ts` — all spec §8 tables created idempotently (WAL mode,
foreign keys on). `Db` type = `InstanceType<typeof DatabaseSync>`. Loaded via `createRequire`
(see Decision log). Helpers: `openDatabase(path)`, `listTables(db)`.

### Settings storage
✅ `src/main/services/settings.ts` — key/value rows; `getSettings` merges over `DEFAULT_SETTINGS`;
`updateSettings(patch)` upserts; `seedSettings` seeds on first run. Default `allowNetwork:false`,
`workspaceMode:'plaintext_dev'`, `contextTokens:4096`. **Phase 7 added `lastBenchmark`**
(JSON `BenchmarkResult | null`, default `null`) — the persisted hardware profile lives here.
**The post-MVP UX round added `autoStartActiveModel`** (boolean, default `true`) **and
`checksumCache`** (`Record<path, {size, mtimeMs, sha256}>`, default `{}` — the persisted L2 of
the weight-file hash cache).
⚠️ **Settings live INSIDE the (possibly encrypted) DB** — unreadable before unlock (Phase 9). The
unencrypted `config/workspace.json` vault descriptor is the only pre-unlock artifact;
`workspaceMode` is set to the active mode by the `WorkspaceController` on open.

### Workspace/paths
✅ `src/main/services/workspace.ts` — `resolvePaths({envRoot,fallbackRoot})` → `ResolvedPaths`
(rootPath, workspacePath, modelsPath, logsPath, configPath, dbPath, isPreparedDrive).
`ensureWorkspaceDirs`, `buildDriveStatus` (adds platform/arch/free/writable). See `docs/drive-layout.md`.

### Core IPC (Phase 1 live)
✅ `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings` registered in
`src/main/ipc/registerCoreIpc.ts`, invoked from `initBackend()` in `main/index.ts`.

### Models + runtime (Phase 2 live)
✅ **Manifest** schema/validator in `src/shared/manifest.ts` (`ModelManifest`, `validateManifest`,
`isRealSha256`). YAML files under `model-manifests/` (originally chat: Qwen3 4B/8B/14B Q4 + 30B-A3B
MoE + embeddings: E5 small F16 — five; 1.7B dropped, see §9). **The live catalog is now 11 manifests**
(8 chat + E5 + bge-reranker + whisper transcriber, in `model-manifests/{chat,embeddings,reranker,
transcriber}/`) — `model-policy.md` is the authoritative list.
✅ **`services/models.ts`** — `resolveManifestsDir`, `discoverManifests`, `sha256File`,
`verifyChecksum`, `computeInstallState`, `recommendModelId`, `buildModelList`, `selectModel`.
States: `unsupported→missing→checksum_failed→installed` (+`running` overlay). `ModelInfo` shape per
`shared/types.ts`. `local_path` resolved against the **drive root**.
✅ **`services/runtime/`** — `ModelRuntime` interface + `RuntimeManager` (single active runtime,
restart on switch) + `MockRuntime` (health ok; `chatStream` stubbed until Phase 3). Factory swap →
`LlamaRuntime` in Phase 10. `RuntimeStatus` shape per `shared/types.ts`.
✅ **IPC** `src/main/ipc/registerModelIpc.ts` — `listModels`, `selectModel`, `startRuntime`,
`stopRuntime`; wired in `initBackend()`. `ctx` now carries `runtime` + `manifestsDir`. Runtime stopped
on `will-quit`. Preload exposes all four. **Models screen** renders states/license/recommend/verify/
select/start-stop. Hardware profile now comes from the **persisted Phase-7 benchmark**
(`lastBenchmark?.profile ?? 'UNKNOWN'`); the old `LITE` stub is gone.

### Chat + streaming (Phase 3 live)
✅ **`services/chat.ts`** (spec §7.6) — `createConversation`, `listConversations`,
`getConversation`, `listMessages`, `appendMessage`, `deleteLastAssistantMessage`,
`maybeSetTitleFromFirstMessage`, `buildSystemPrompt` (verbatim spec §7.6 base prompt, exported as
`BASE_SYSTEM_PROMPT`), `buildChatMessages`, and the streaming orchestrator
`generateAssistantMessage(db, runtime, conversationId, { signal, onToken })`. UUID v4 ids,
ISO-8601 UTC timestamps. **Message order = `created_at ASC, rowid ASC`** (rowid breaks
equal-ms ties → stable turn order). **System prompt is built per request, NOT persisted**; the
`messages` table holds only user/assistant turns. `Conversation`/`Message` shapes per
`shared/types.ts`. `messages.citations_json` stays null until Phase 6.
✅ **Title:** new conversations are `"New chat"`; first user message sets the title (≤60 chars),
later messages don't overwrite it. Conversations list newest-updated first.
(Phase 42: the default is persist-canonical English — `t('en', 'main.chat.defaultTitle')`,
value unchanged — and display-mapped to the UI language at render, D-L4.)

### Streaming contract (LOCKED — Phase 3; one ADDITIVE channel in Phase 20)
Main → renderer over per-conversation IPC event channels keyed by the **conversation id**
(one active stream per conversation): `chat:token:<id>` (one token/event) / `chat:done:<id>`
(final assistant `Message`) / `chat:error:<id>` (error string). Helpers in `src/shared/ipc.ts`
`STREAM`. Preload exposes `onToken/onDone/onError(requestId, cb) → unsubscribe`. In addition,
`sendChatMessage(conversationId, content, options?)` resolves with the final assistant `Message`,
so callers can simply `await` it; the event channels drive incremental UI.
**Phase 20 (additive):** `chat:reasoning:<id>` (preload `onReasoning`) carries Deep-mode
thinking deltas; token events still carry ONLY answer text. Reasoning is never persisted and
never replayed (D6) — see "Answer-depth modes" below.
**Cancellation:** `ipc/registerChatIpc.ts` keeps a per-conversation `AbortController` map;
`stopGeneration(conversationId)` aborts it → `chatStream` stops on `options.signal`, the partial
reply is persisted, a normal `done` fires.
**Regenerate:** `sendChatMessage` with `options.regenerate = true` deletes the last assistant
message and re-streams from existing history (no new user turn).
**Decision (documented):** `sendChatMessage` does **not** auto-start a runtime — a chat needs a
model explicitly started on the Models screen. No active runtime → handler throws; Chat screen
shows a "start a model" empty state linking to Models. (Heavy llama.cpp start in Phase 10 stays an
explicit user action; keeps the boundary clean.)
✅ **`MockRuntime.chatStream`** now emits a deterministic reply token-by-token (12 ms/token) that
echoes the last user message, honouring `options.signal` for prompt cancellation. **Chat screen**
(`renderer/screens/ChatScreen.tsx`): conversation list, streamed transcript with a live cursor,
stop, regenerate, per-message copy, and the no-runtime empty state.

### Answer-depth modes (Phase 20 live)
✅ `ChatOptions.mode` (`'fast' | 'balanced' | 'deep'` = `ChatDepthMode`) is **read** now:
per message over IPC (enum-guarded in `registerChatIpc`), sticky per conversation in the
renderer for the session (NOT persisted — no schema change). Threads
`generateAssistantMessage` → `RuntimeChatOptions.mode`; the single mapping site is
`runtime/llama.ts` `requestParamsForMode` (D4): fast = thinking off + temp 0.7 + 1024-token
cap · balanced/omitted = thinking off, server defaults · deep = thinking on + temp 0.6.
Explicit `maxTokens`/`temperature` win over mode-derived values.
✅ **Thinking switch (D5):** per-request `chat_template_kwargs: { enable_thinking }` on
`/v1/chat/completions`, ALWAYS sent explicitly (the b9585 default is thinking ON for capable
templates). Chat sidecars spawn with **`CHAT_SERVER_ARGS` = `--jinja --reasoning-format
deepseek`** (pins the mechanism's preconditions; embedder excluded). Reasoning streams as
separate `delta.reasoning_content` frames → `RuntimeChatOptions.onReasoning(delta)` →
`chat:reasoning:<id>`; the generator yields answer text only.
✅ **D6:** `stripThinkBlocks` (services/chat.ts) scrubs `<think>…</think>` (incl. an unclosed
trailing block) from persisted assistant content (chat + grounded) and from assistant turns
replayed as history. The collapsed live "Thinking…" block in the streaming bubble is the only
reasoning surface, and it disappears once the persisted reply lands.
✅ **Deep gating:** manifest `supports_thinking_mode` → `ModelManifest.supportsThinkingMode`
(optional boolean, default false) → `RuntimeStatus.supportsThinkingMode` (enriched by the
`getRuntimeStatus` handler for the running model only) → the composer offers Deep only when
true (stale Deep choices coerce to Balanced at send). `askDocuments` never passes a mode —
document answers always run balanced (deep-grounded = wave 2).

### Document ingestion (Phase 4 live)
✅ **`services/ingestion/`** (spec §7.7). Full detail in [`docs/rag-design.md`](docs/rag-design.md).
- **`parsers/`** — `DocumentParser` interface (`{ segments: ExtractedSegment[], mimeType }`) +
  registry (`selectParser`, `supportedExtensions`). Adapters: `TxtParser` (.txt/.text/.log),
  `MarkdownParser` (.md/.markdown/.mdown; segment per ATX heading, `sectionLabel`), `PdfParser`
  (.pdf; pdfjs-dist **legacy** build, no worker; segment per page, `pageNumber`), `DocxParser`
  (.docx; mammoth raw text; segment per paragraph), `CsvParser` (.csv/.tsv; papaparse; rows →
  `header: value` lines). Pure-JS, **lazy-imported** inside `parse()`.
  **Phase 36 additions:** `AudioParser` (.wav/.mp3/.flac/.ogg — the R-W2-verified list; packs
  whisper segments into ≤400-word `ExtractedSegment`s labeled `sectionLabel: "mm:ss–mm:ss"`),
  and `parse(filePath, ctx?)` gained an ADDITIVE optional `ParseContext`
  (`{ transcriber?, onProgress?, workDir? }`) — text parsers ignore it. `IngestionDeps` gained
  optional `transcriber` + `onTranscribeProgress(documentId, percent)` (the embedder-injection
  precedent); `isAudioPath()` + `summarizeImportPaths()` exported for the IPC layer.
- **`chunker.ts`** — `chunkSegments(segments, opts?)` → `DocumentChunk[]`. `CHUNK_DEFAULTS =
  { chunkSizeTokens: 500, chunkOverlapTokens: 80, maxChunks: 1000 }`. **Token counting is an
  approximation** (1 whitespace word ≈ 1 token; `tokenize`/`approxTokenCount`). Windows step by
  `size − overlap`, overlap clamped `< size`, no chunk crosses a segment boundary (so each chunk
  has exactly one `pageNumber`/`sectionLabel`), global cap at `maxChunks`.
- **`index.ts`** — lifecycle + persistence. `createQueuedDocument`, `processDocument` (never
  throws: failures → `failed` + `error_message`), `reindexDocument`, `listDocuments`,
  `getDocument`, `deleteDocument`, `expandPaths`, `documentsDir`. Statuses
  `queued→extracting→chunking→embedding→indexed` (+`failed`/`deleted`); **`embedding` is a
  pass-through** until Phase 5 (no vectors written yet).
- **DB:** `documents` (status, `original_path`, `stored_path`, `sha256`, `mime_type`,
  `size_bytes`) + `chunks` (`chunk_index`, `text`, `source_label` = document title,
  `page_number`, `section_label`, `token_count`). `chunkCount` is computed per `listDocuments`.
- **Types:** `DocumentInfo`, `ImportJob`, `ImportJobStatus`, `IngestionStatus` (already in
  `shared/types.ts`) filled to match.

### Document storage + import model (LOCKED — Phase 4)
- **Stored copy.** Imports are **copied into `workspace/documents/<id><ext>`** (`stored_path`);
  `original_path` is also kept. Self-contained drive: re-index re-parses the stored copy; delete
  removes the stored copy + chunks + embeddings + row (never the original).
- **Async-with-polling.** `importDocuments(paths)` expands the selection, inserts `queued` rows,
  returns `{ jobId, documentIds }`, then ingests **sequentially in the background**. The
  `documents` table is the per-file source of truth (survives restart); the `ImportJobStatus`
  aggregate is **in-memory** in `registerDocsIpc.ts`, read via `getImportJob(jobId)` (unknown job
  → `done:true` so pollers stop). The **Documents screen** polls `getImportJob` + `listDocuments`
  every 400 ms while a job runs. No streaming channel is used (ingestion progress is coarse).
- **Picker.** `pickDocuments('files' | 'folder')` opens the OS dialog in **main**
  (renderer has no dialog access); Windows can't mix file+dir selection, hence the mode.
- **Documents screen** (`renderer/screens/DocumentsScreen.tsx`): import files/folder, per-file
  status badge + chunk count + size, error surfacing, delete + re-index.

### Embeddings + vector search (Phase 5 live)
✅ **`services/embeddings/`** (spec §6, §7.8, §9.2). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §6.
- **`index.ts`** — `Embedder` interface (`id`, `dimensions`, `embed(texts) =>
  Promise<Float32Array[]>` — L2-normalized, one per input); `encodeVector`/`decodeVector`
  (Float32 ↔ BLOB; decode copies to a 4-byte-aligned buffer); `cosineSimilarity`; and the
  `VectorIndex` class (`search(queryVector, topK)` linear-scan cosine → `{ chunkId, score }[]`
  sorted desc, dimension-mismatched rows skipped; `searchText(query, topK)` embeds then searches).
- **`mock.ts`** — `MockEmbedder` (`createMockEmbedder`): deterministic feature-hashing vectors
  (SHA-256 tokens → signed buckets → L2-normalize), zero network. `MOCK_EMBEDDING_DIMENSIONS =
  384`, `MOCK_EMBEDDING_MODEL_ID = 'mock-embedder'`.
- **Ingestion wiring:** `processDocument`/`reindexDocument` accept `IngestionDeps
  { embedder?, embeddingModelId? }`; the `embedding` step embeds all chunks in one batch and
  inserts `embeddings` rows. `registerDocsIpc` passes `ctx.embedder` +
  `getSettings(db).activeEmbeddingModelId`. **`AppContext` now carries `embedder`** (created in
  `main/index.ts`).
- **`embeddings` table** (spec §8, already existed): `chunk_id` PK, `embedding_model_id`,
  `vector_blob` (raw Float32 bytes), `dimensions`, `created_at`. No new IPC (askDocuments = Phase 6).

### RAG chat with citations (Phase 6 live)
✅ **`services/rag/index.ts`** (spec §7.6, §7.8). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §8.
- **`retrieve(db, embedder, question, settings)`** → `{ chunks: RetrievedChunk[], citations:
  Citation[] }`. Embeds the question, `VectorIndex.searchText(topKInitial)`, joins hits →
  `chunks`, drops `< minSimilarity`, **dedups by `(document_id, page_number)`** (page-less
  chunks keyed by chunk id), trims to `topKFinal` under `maxContextTokens` (chunker's
  `approxTokenCount`; top chunk always kept), assigns `[S1]…` labels **per query (not
  stored)**.
- **`buildGroundedPrompt(question, chunks)`** — pure; spec §7.8 template verbatim (rules +
  `Question:` + numbered `Document excerpts:` as `[Sn] File: X | Page: 4` / `| Section: Y` +
  quoted text + trailing `Answer:`). `buildGroundedChatMessages` replaces the **last user
  turn** with the grounded prompt; system stays `BASE_SYSTEM_PROMPT`.
- **`generateGroundedAnswer(...)`** — streams via the runtime and persists the assistant turn
  **with `Citation[]`** (→ `citations_json`). **Empty corpus / weak retrieval → runtime NOT
  called**; persists `NO_DOCUMENT_CONTEXT_ANSWER`, no citations.
- **`ipc/registerRagIpc.ts`** — `askDocuments(conversationId, question)`; **reuses the locked
  Phase-3 streaming contract** (`chat:token/done/error:<id>`) + the **shared in-flight
  registry** (`ipc/inflight.ts`) so `stopGeneration` cancels it. Requires a running runtime
  (same error as chat). Registered in `initBackend()`.
- **Settings:** `ragTopKInitial`/`ragTopKFinal`/`ragMaxContextTokens`/`ragMinSimilarity` on
  `AppSettings` + `DEFAULT_SETTINGS` (spec §7.8 defaults), read via `ragSettingsFrom`.
- **`Citation`** gained optional `snippet` (truncated chunk text, ≤ 600). **Renderer**:
  `ChatScreen` Chat/Ask-Documents toggle (mode is per-conversation), `askDocuments` path, and
  a per-message **Sources** panel with expandable cited snippets.
- **Phase 21 (hybrid + rerank — see the §3 entry / `docs/rag-design.md` §11):** `retrieve()`
  gained a keyword pass (`rag/hybrid.ts` over the trigger-synced `chunks_fts` FTS5 table) fused
  by RRF (k=60), and an optional trailing `reranker?: Reranker | null` param (also on
  `GroundedAnswerOptions.reranker`) that reorders candidates between fusion and dedup. Absent
  reranker + no keyword hits ⇒ byte-identical to the Phase-6 pipeline. `RetrievedChunk.score`
  is stage-dependent (cosine / RRF / rerank logit); `minSimilarity` stays a PRE-rerank cosine
  floor; citations still persist NO scores. `Reranker` lives in `services/reranker/`
  (`AppContext.reranker`, availability-selected, null default). `Embedder`/`Reranker` gained
  optional **`suspend()`** — the workspace-lock teardown that allows a lazy restart (`stop()`
  stays permanent for will-quit).

### Hardware benchmark + recommendation (Phase 7 live)
✅ **`services/benchmark.ts`** (spec §7.3, §11). Full detail in [`docs/benchmark.md`](docs/benchmark.md).
- **`detectSystem()`** (`node:os`) → `{ os, arch, cpuModel, cpuCores, ramGb, gpu }`; never
  throws (failed probe → `''`/`0`); `detectSystem` itself always reports `gpu: null` — the
  REAL probe lives in `runtime/gpu.ts` and is **injected** by the IPC layer (Phase 16:
  `RunBenchmarkDeps.gpu: { name, useful }`), keeping this module `child_process`-free.
- **`classifyProfile(ramGb, { tokensPerSecond?, gpuUseful? })`** — pure; spec §11.3
  thresholds + the conservative Phase-16 GPU bump (`gpuUseful` is precomputed by
  `gpuUsefulForProfile`: ≥ 6144 MiB AND not integrated) + low-tok/sec downgrade; invalid
  RAM → `UNKNOWN`.
- **`measureDriveSpeed(workspacePath)`** → `{ readMbps, writeMbps, error? }`; 8 MB temp file
  written **inside the workspace**, timed write(`fsync`)+read, **always cleaned up**, failure
  → `null` + `error`.
- **`measureTokensPerSecond(runtime)`** → number | `null` (only when a runtime is active;
  prompt + ≤64 tokens). Mock now, real in Phase 10.
- **`buildWarnings(...)`** — spec §11.4 friendly copy (weak hardware / slow drive /
  un-measurable drive); slow drive warns, never blocks.
- **`runBenchmark(deps)`** → `BenchmarkResult` (the existing `shared/types.ts` shape):
  detection + drive + optional tokens/sec + `classifyProfile` + `recommendModelId` + warnings.
- **`ipc/registerBenchmarkIpc.ts`** — `runBenchmark()` (`benchmark:run`); runs it, persists to
  `settings.lastBenchmark`, returns the result. Registered in `initBackend()`; exposed on
  preload `api.runBenchmark` + `PreloadApi`.
- **Renderer:** `DiagnosticsScreen` Run-benchmark button → RAM / CPU / OS-arch / drive
  read-write / tokens-sec / profile / recommended model + warnings; re-loads `lastBenchmark`
  on mount. `HomeScreen` profile reflects the persisted value via `getAppStatus`.

### Privacy & offline policy (Phase 8 live)
✅ **`services/policy.ts`** (spec §3.5/§3.6/§6). Pure + resilient; never throws.
- **Types** (in `shared/types.ts`): `PrivacyPolicy` (`network`/`workspace`/`models`),
  `NetworkPolicy`/`WorkspacePolicy`/`ModelsPolicy`, `PolicyStatus`. `DEFAULT_POLICY` lives in
  `policy.ts` (main-only).
- **`parsePolicy(contents, onWarn?)`** → `PrivacyPolicy` merged over `DEFAULT_POLICY`; malformed JSON
  → defaults + warn. **`mergePolicyObject(base, raw)`** maps snake_case JSON → camelCase, taking a
  field only when it is a real boolean. **`loadPolicy(configDir, onWarn?)`** → `{ policy,
  policyFilePresent, driveFilePresent, allowNetworkByDefault }` (reads optional `policy.json` +
  `drive.json`).
- **`resolveNetwork(policy, allowNetworkSetting)`** → `{ networkAllowedByPolicy, networkAllowed,
  offlineMode }` (effective = policy ∧ setting). **`buildPolicyStatus(configDir, allowNetworkSetting,
  onWarn?)`** → `PolicyStatus` (the `getPolicy()` IPC shape; `telemetryAllowed` hardcoded false).
✅ **`services/offlineGuard.ts`** — `isLoopbackHost(host)` (127.0.0.0/8, ::1, localhost exempt),
  `checkOutboundHost(host, offline)` → `{ host, violation }`, `installOfflineNetworkGuard({ offline,
  onViolation })` (wraps `net.Socket.prototype.connect`, logs remote attempts, **never blocks**,
  returns an uninstaller; no-op when not offline), `assertOfflinePosture({ posture, installGuard,
  log, warn })` (startup self-check; logs posture, installs the guard in ALL builds when offline).
✅ **IPC** `registerCoreIpc.ts`: `getPolicy` (`policy:get`) returns `buildPolicyStatus(...)`;
  `getAppStatus.offlineMode`/`networkAllowed` now come from the policy resolution. Preload exposes
  `api.getPolicy` + `PreloadApi`. `main/index.ts` calls `assertOfflinePosture()` in `initBackend()`
  and applies the dev/prod CSP response header in `createWindow()`.
✅ **Renderer:** `PrivacyScreen.tsx` (spec §7.10/§18.1 copy) replaces the placeholder — offline
  statement, "where your data lives" (`getDriveStatus`), live network state (off by default /
  disabled by policy), plaintext-dev-mode caveat, logs-local guarantee. Sidebar `offline-badge` is a
  live button (reads `getPolicy`, links to Privacy).

### Encrypted workspace (Phase 9 live)
✅ **`services/security/crypto.ts`** (spec §3.5) — pure KDF + AEAD, no I/O.
- **KDF:** `deriveKey(password, salt, params)` → 32-byte key. `KdfParams` is per-algo
  (`argon2id: m/t/p` · `scrypt: N/r/p`); `DEFAULT_KDF = { argon2id, m=19456, t=2, p=1, keyLen=32 }`
  for NEW vaults, `SCRYPT_KDF = { scrypt, N=32768, r=8, p=1 }` still unlocks legacy vaults (see the
  §3 KDF decision). `generateSalt()` → 16 random bytes. Deterministic for the same
  password+salt+params.
- **AEAD:** `encrypt(key, plaintext) → { iv(12), tag(16), ciphertext }` (AES-256-GCM, fresh IV),
  `decrypt(key, blob)` (throws on wrong key/tamper). `serializeBlob`/`deserializeBlob`
  (`MAGIC(8)|iv|tag|ct` on-disk frame). `makeVerifier(key)`/`verifyKey(key, verifier)` (password
  check via a known-plaintext GCM blob — never touches the DB).
✅ **`services/workspace-vault.ts`** (spec §7.9) — the lock/unlock lifecycle.
- **Descriptor:** `VaultDescriptor { version, mode:'encrypted', kdf, saltB64, verifier }` at
  **`config/workspace.json`** (unencrypted; the only pre-unlock artifact).
  `readVaultDescriptor`/`writeVaultDescriptor` (atomic). `vaultPathsFrom({configPath,dbPath})` →
  `VaultPaths { descriptorPath, encPath = <dbPath>.enc, dbPath }`.
- **File crypto + hygiene:** `encryptFile`/`decryptFile` (atomic temp+rename), `shredFile`
  (overwrite-random + unlink, best-effort), `cleanSidecars` (shred `-wal`/`-shm`).
- **Lifecycle:** `createEncryptedVaultOnDisk(vaultPaths, password, kdf?)` (writes descriptor + seeds
  an initial DB + encrypts → `.enc` + shreds, leaving it LOCKED); `unlockEncryptedVault(vaultPaths,
  password) → { db, key, descriptor }` (verify → decrypt → open; throws **`WrongPasswordError`**);
  `lockEncryptedVault(vaultPaths, db, key)` (checkpoint+close → re-encrypt → shred).
  `plaintextAllowed(policy, {isDev, developerMode})` gates plaintext (now **enforced**).
- **`WorkspaceController`** (stateful, on `AppContext`): `init()` (startup: plaintext opens
  immediately, encrypted stays locked, else uninitialized), `getState() → WorkspaceStateInfo`,
  `requireDb()` (throws while locked), `isUnlocked()`, `unlock(password)`, `create(password, mode)`,
  `lock()` (no-op for plaintext).
✅ **IPC** `ipc/registerWorkspaceIpc.ts` — `getWorkspaceState` (`workspace:getState`) →
  `WorkspaceStateInfo`; `unlockWorkspace(password)` / `createWorkspace(password, mode)` →
  **`WorkspaceActionResult`** (`{ok:true,state}` | `{ok:false, reason:'wrong_password'|'refused'|
  'error', message}` — a wrong password / policy refusal is a normal result, not a throw);
  `lockWorkspace` → `WorkspaceStateInfo`. Registered in `initBackend()`; exposed on preload `api` +
  `PreloadApi`.
- **Types** (`shared/types.ts`): `WorkspaceStateName` (`uninitialized|locked|unlocked`),
  `WorkspaceStateInfo { state, mode, plaintextAllowed, encryptionRequired }`, `WorkspaceActionResult`.
✅ **`AppContext.db` is now a getter** over `workspace.requireDb()` (throws while locked) +
  `AppContext.workspace: WorkspaceController`. `main/index.ts` builds the controller from
  `loadPolicy(...).policy` + `isDev`, calls `init()`, and locks on `will-quit`. `registerCoreIpc`'s
  `getAppStatus` now derives `workspaceReady = workspace.isUnlocked()` and `workspaceMode` from the
  controller (reads settings only when unlocked); `getPolicy`/status default `allowNetwork=false`
  while locked (offline ceiling stays intact pre-unlock).
✅ **Renderer:** `screens/WorkspaceGate.tsx` — the pre-app create-password / unlock gate (encrypted
  vs plaintext choice when policy allows, confirm + strength hint, wrong-password error). `App.tsx`
  fetches `getWorkspaceState()` on mount and renders the gate until `unlocked`; sidebar **Lock now**
  button (encrypted only) calls `lockWorkspace`. The Settings workspace card reflects the real mode.

### Real runtime + embedder (Phase 10 live)
✅ **`services/runtime/sidecar.ts`** — discovery + `LlamaServer` lifecycle.
- `resolveLlamaServerPath(rootPath, platform, env)` → binary path | null (`runtime/llama.cpp/<os>/`,
  `HILBERTRAUM_LLAMA_BIN` override); `llamaServerDir`/`llamaServerBinaryName`/`llamaOsDir`; `findFreePort()`;
  `defaultThreadCount()`; `LOOPBACK_HOST = '127.0.0.1'`.
- **`LlamaServer`** owns one child process: `start()` (spawn `--host 127.0.0.1 --port <random> --model
  --ctx-size --threads` + `extraArgs`, then poll `/health` with a **timeout** → throw on crash/timeout),
  `health() → HealthStatus`, `fetch(path, init)` (loopback), `stop()` (kill **and wait for exit**).
  Test seams: injectable `spawn` / `fetchImpl` / `findPort` (+ `ChildProcessLike`/`SpawnFn`/`FetchFn`).
✅ **`services/runtime/llama.ts`** — `LlamaRuntime implements ModelRuntime` (composes `LlamaServer`);
  `chatStream` → OpenAI-compatible `/v1/chat/completions` (`stream:true`, role/content, `max_tokens`/
  `temperature`), `readChatSSE(body, signal)` exported (SSE delta parser). `createLlamaRuntime(opts, deps)`.
✅ **`services/runtime/factory.ts`** — `createSelectingRuntimeFactory({ rootPath, resolveBin?,
  modelExists?, makeLlama?, makeMock?, onSelect? }) → RuntimeFactory` (real iff binary + weights present,
  per `start()`; else mock). Used by `RuntimeManager` in `main/index.ts`.
✅ **`services/embeddings/e5.ts`** — `E5Embedder implements Embedder` (id = manifest id, 384 dims,
  L2-normalized; lazy `llama-server --embedding --pooling mean` sidecar; additive `stop()`).
  `createE5Embedder(opts)`. **`Embedder` gained optional `stop?(): Promise<void>`** (mock omits it).
✅ **`services/embeddings/factory.ts`** — `createSelectedEmbedder({ rootPath, model, … }) → Embedder`
  (real `E5Embedder` iff binary + E5 weights present; else `MockEmbedder`). `EmbeddingModelInfo {
  id, modelPath, dimensions?, contextTokens? }`.
✅ **`VectorIndex`** — optional 3rd ctor arg `{ embeddingModelId? }`: a non-empty id scopes the cosine
  scan to `WHERE embedding_model_id = ?` (mismatch guard); default scans all rows. **`rag.retrieve`**
  passes `{ embeddingModelId: embedder.id }`.
✅ **`main/index.ts`** — builds the selecting runtime factory + selected embedder; `resolveEmbeddingModel`
  reads the embeddings manifest pre-unlock; `will-quit` now also calls `ctx.embedder.stop?.()`.
  **R5: live inference is manual** (binaries + GGUF not in repo); everything else is tested with a mocked
  child process / mocked loopback `fetch`.

### Drive layout, scripts & packaging (Phase 11 live)
✅ **`services/drive.ts`** — the canonical, unit-tested reference for drive prep (the scripts mirror it):
- `DRIVE_OS_DIRS = ['win','mac','linux']`, `DRIVE_LAYOUT_DIRS` (workspace, models/{chat,embeddings},
  model-manifests, runtime/llama.cpp/{win,mac,linux}, logs, config, docs), `driveLayoutDirs(root)`.
- `buildDriveJson(opts) → DriveJson` (the `config/drive.json` marker, spec §6 shape);
  `buildPolicyJson({dev?}) → PolicyJson` (snake_case; network always denied; commercial vs dev posture).
- `verifyDriveModels(root, manifests) → ModelVerifyResult[]` (status `verified|unverified_placeholder|
  mismatch|missing|unsupported`, reusing `models.ts` `verifyChecksum`/`isRealSha256`);
  `buildChecksumsJson(root, manifests) → ChecksumsJson` (generate-mode capture of present-weight hashes).
- `planPrepareDrive(root, manifests, opts) → PreparePlan` (dirs + config files + manifest copies +
  weight destinations + `configWouldOverwrite`) + `formatPlan` (the dry-run report).
✅ **`scripts/`** (repo root, self-contained; no Node/npm needed to prep a drive):
- `prepare-drive.{ps1,sh}` — `-Target`/`--target` (required), `-DryRun`/`--dry-run`, `-Force`/`--force`,
  `-Dev`/`--dev`. Creates the layout, copies `model-manifests/` + user docs onto the drive, writes
  `config/{drive,policy}.json`. Idempotent; config only (re)written with `--force`.
- `verify-models.{ps1,sh}` — `-Target`/`--target`, `-Generate`/`--generate`. Flat-YAML line-parses the
  manifests, SHA-256s present weights, prints `VERIFIED/UNVERIFIED/MISMATCH/MISSING/UNSUPPORTED`,
  **exit 1 on a real-hash mismatch**; `--generate` writes `config/checksums.json`.
- `setup-dev.{ps1,sh}` — `NODE_OPTIONS=--use-system-ca npm install` (R6) + build + test smoke.
✅ **Packaging** — `apps/desktop/electron-builder.yml` (portable Windows + mac/linux parity;
  `model-manifests/` as `extraResources`; asar; Electron ≥37). `npm run package` / `package:win`
  (root + workspace). New dev dep **`electron-builder ^26.15.2`**. Output → `apps/desktop/release/`
  (git-ignored, added to `.gitignore` alongside the existing `models/`/`*.gguf`/`/runtime/` ignores).
✅ **Docs** — `docs/user-guide.md` (non-technical §17 path) + `docs/troubleshooting.md` (§18) added;
  `docs/packaging.md` + `docs/drive-layout.md` extended (portable build, the scripts, win/mac/linux
  reconciliation). prepare-drive copies user-guide/troubleshooting + `PRIVACY.md` onto the drive.

### Provisioning / asset loader (Phase 12 live)
✅ **Schema** — `shared/manifest.ts` `DownloadSpec` + optional `ModelManifest.download` (validated only
  when present; real `download.sha256` must equal a real top-level `sha256`). `shared/runtime-sources.ts`
  `RuntimeBuild`/`RuntimeSources` + `validateRuntimeSources` (mirror `validateManifest`). The committed
  model manifests (the original six, incl. the later 14B/30B-A3B) carry real upstream URLs + placeholder hashes.
  **(Updated since Phase 12 — see `model-policy.md` for the live catalog: the catalog is now 11
  manifests (8 chat + E5 + bge-reranker + whisper transcriber), and `runtime-sources.yaml` is pinned
  to the REAL `ggml-org/llama.cpp@b9585` release with real URLs + SHA-256, plus `whisper_cpp:`/`ocr:`
  asset blocks — the original "b9196 placeholder / one CPU build per OS" text below is the Phase-12
  as-built snapshot.)** The Phase-12 snapshot: `runtime-sources.yaml` referenced
  `ggml-org/llama.cpp@b9196` as a PLACEHOLDER, one CPU build per OS.
  `models.ts` `RESERVED_MANIFEST_FILES` excludes `runtime-sources.yaml` from model discovery.
✅ **`services/assets.ts`** — the canonical, unit-tested asset logic (mirrors `drive.ts`; NO real network):
- `planModelDownloads(root, manifests, {only?, acceptLicense?}) → ModelDownloadTask[]` — only manifests
  with a `download` block; reads fs to mark `present-verified`/`present-unverified`/`download`/
  `license-blocked` (license gate ∧ `acceptLicense`); reuses `weightPath`/`verifyChecksum`.
- `selectRuntimeBuild(sources, {os, arch, backend?}) → RuntimeBuild | null` (default = first os/arch
  match = the CPU build) · `planRuntimeDownload(root, build, version) → {url, zipDest, extractTo,
  binaryPath, sha256, ...}` (escape-guarded) · `runtimeBinaryName(os)`.
- `verifyDownloadedFile(path, expected) → {ok, actual, reason}` (placeholder/missing/mismatch are NOT a
  pass) · `downloadToFile(url, dest, {fetchImpl?, onProgress?})` + `fetchAndVerify(task, deps)` (injected
  fetch; mismatch deletes the partial + throws) · `formatAssetPlan(modelTasks, runtimePlan)`.
✅ **`scripts/`** (self-contained, dual `.ps1`/`.sh`, OS-native downloader; `.ps1` pure ASCII):
- `fetch-models.{ps1,sh}` — `-Target`/`--target` (req), `-Only`/`--only`, `-AcceptLicense`/
  `--accept-license`, `-DryRun`/`--dry-run`. Per `download`-block manifest: download (resume via
  `curl -C -`/`aria2c`) → SHA-256-verify vs the manifest → mismatch deletes partial + **exit 1**;
  placeholder → *UNVERIFIED*; present+verified → skip. License gate before the first fetch.
- `fetch-runtime.{ps1,sh}` — `-Target`/`--target` (req), `-Os/-Arch/-Backend` overrides, `-DryRun`.
  Reads `runtime-sources.yaml`, picks the host build (default CPU), downloads + verifies the zip,
  `Expand-Archive`/`unzip`/`ditto` into `runtime/llama.cpp/<os>/`, `chmod +x` on mac/linux. Idempotent.
- `prepare-drive.{ps1,sh}` gained `-WithAssets`/`--with-assets` (+ forwards `-AcceptLicense`): after the
  layout, runs `fetch-models` + `fetch-runtime` so one command yields a launch-ready drive. Without the
  flag, behaviour is unchanged. Then points the user at `verify-models --generate`.
  - **Fast-setup default (2026-06):** `-WithAssets` fetches a small but complete **default set** —
    `ministral3-8b-instruct-2512-q4` (chat) + `multilingual-e5-small-q8` (embeddings) +
    `bge-reranker-v2-m3-f16` (reranker) + `whisper-small-multilingual` (transcriber), each via
    `fetch-models --only` (looped, since `--only` takes one id) — **plus both sidecar runtimes**:
    `fetch-runtime` (llama.cpp, default family) AND `fetch-runtime --family whisper_cpp`. Not all ~11
    models; the user pulls the rest (larger chat models) from the app on demand. `-AllModels`/`--all-models` restores fetch-everything
    (one `fetch-models` call, no `--only`); the runtimes are fetched either way. The default id list is
    a `$DefaultModelIds`/`DEFAULT_MODEL_IDS` constant at the top of each script (keep in sync with
    `model-manifests/`). The whisper.cpp runtime fetch is **best-effort**: prebuilt binaries are
    Windows-only, so on a mac/linux host the "no build" miss is a warning, not a failure (those drives
    build whisper.cpp from source). The commercial build (`build-commercial-drive`) calls `fetch-models`
    directly, so it still pre-loads every model — unaffected.
✅ **In-app downloader (the provisioning plan's deferred item)** — ~~deferred~~ **shipped in Phase 18** (see the contract
  section below). **Real downloads + USB-drive launch = manual (R5).**

### In-app model downloader (Phase 18 live)
✅ **Types** (`shared/types.ts`): `DownloadJobStatus = 'queued'|'downloading'|'verifying'|'done'|
  'failed'|'cancelled'`; `DownloadJob { jobId, modelId, status, receivedBytes, totalBytes,
  unverified, error }` (`unverified` = placeholder-hash download, the model stays UNVERIFIED);
  `ModelInfo.download?: ModelDownloadInfo { url, sizeBytes, licenseUrl, licenseApproved }`.
✅ **`services/downloads.ts`** — `DownloadGates { policyAllows, settingAllows }`,
  `assertDownloadAllowed(gates)` (friendly, cause-specific refusals: policy vs. Settings),
  `partPath(dest)`, `DownloadManager({ fetchImpl?, log? })` with `start({rootPath, manifest,
  gates, licenseAccepted?, hashStore?}) → Promise<DownloadJob>`, `get(jobId)`, `cancel(jobId)`
  (keeps the `.part`), `activeJob()`. One live job at a time; `.part` → verify → rename;
  mismatch deletes the partial; success invalidates the checksum-cache entry.
✅ **`assets.ts` seam (additive):** `DownloadDeps += { signal?, headers?, append?, onResponse? }`,
  `downloadToFile → DownloadToFileResult { status, received, contentLength }` (append only on a
  real 206); `PlanModelOptions += { hashStore? }` (present multi-GB weights are not re-hashed).
✅ **IPC** `ipc/registerDownloadIpc.ts` — `downloadModel(modelId, {licenseAccepted?})`,
  `getDownloadJob(jobId)`, `cancelDownload(jobId)`; gates re-read per call (policy from disk,
  setting from the possibly-locked DB ⇒ off). Preload exposes all three. **Renderer:**
  ModelsScreen Download button (missing/checksum_failed models with a manifest `download`
  block), gate explanations, the confirmation modal (size/license/URL + license-ack checkbox),
  progress + cancel via 1 s polling; SettingsScreen hint updated.

### Audit log (Phase 19 live)
✅ **Types** (`shared/types.ts`): `AuditEventType` (25 values as of Phase 38 — wave 3 added
  document-task/export/password-change events);
  `AuditEvent { id, type, message, metadata: Record<string,unknown> | null, createdAt }`.
✅ **`services/audit.ts`** — `AUDIT_MAX_ROWS = 5000`, `recordEvent(db, type, message, metadata?,
  createdAt?)` (never throws; prunes on insert), `pruneAuditEvents(db, maxRows?)`,
  `listAuditEvents(db, { limit?, beforeId? })` (newest-first; unknown cursor reads from the top),
  `createAuditRecorder(getDb) → AuditRecorder` (locked-vault memory buffer, bounded 100,
  flush-in-order with original timestamps). **`AppContext.audit?: AuditRecorder`** — optional, so
  partial test contexts stay valid; every call site is `ctx.audit?.(…)`.
✅ **`services/downloads.ts` seam (additive):** `DownloadManagerDeps.audit?` (`DownloadAuditType` =
  the three `model_download_*` values) — injected by `registerDownloadIpc` in production.
✅ **`services/offlineGuard.ts` seam (additive):** `AssertOfflinePostureDeps.onViolation?(host)`.
✅ **IPC** `ipc/registerAuditIpc.ts` — `getAuditEvents`, `exportAuditLog` (JSON, save-dialog
  pattern). **Renderer:** Diagnostics Activity card (on-demand, type filter, paging, export).
⚠️ The privacy rule (ids/filenames/counts, never content) is a CONTRACT for every future call
  site — extend the sentinel test when adding events.

### Plug-and-play distribution (Phase 13 live)
✅ **`services/launcher.ts`** — `resolveDriveRootFromLauncher(launcherPath, flavor?: 'win32'|'posix'|
  'auto')` → the drive root (the launcher's own directory; pure path math, no fs). Handles Windows
  drive-letter + POSIX/macOS paths; throws on empty/relative. **No hardcoded path** — the canonical
  reference the launcher scripts mirror.
✅ **`launchers/`** (repo templates copied to the drive root by the pipeline) — `Start Private AI
  Drive.cmd` (`%~dp0` → set `HILBERTRAUM_DRIVE_ROOT` → spawn `HilbertRaum-*-portable.exe`), `Start
  HilbertRaum.command` (macOS, exec the `.app` binary with the env exported), `start-private-ai-
  drive.sh` (Linux, next to the AppImage), `READ ME FIRST.txt` (friendly first-run + SmartScreen/
  Gatekeeper "Run anyway" copy).
✅ **`services/preflight.ts`** — `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) →
  PreflightResult { rootPath, writable, freeBytes, slowDriveWarning, problems[] }` (spec §11.4 tone;
  non-blocking). Reuses `buildDriveStatus` + `measureDriveSpeed`/`buildWarnings`. `LOW_FREE_SPACE_BYTES
  = 2 GB`. `PreflightResult` lives in `shared/types.ts`. IPC `runPreflight` (`preflight:run`) in
  `registerCoreIpc` → preload `api.runPreflight`; **HomeScreen** shows a non-blocking note.
✅ **`services/commercial-drive.ts`** — `planCommercialDrive({ target, os?, acceptLicense? }) →
  CommercialStep[] { id, title, command, manual, description }` (ordered: prepare → fetch-models →
  fetch-runtime → **package [manual]** → copy-app → verify → assert) + `formatPlan`; and
  `assertCommercialDrive(rootPath, manifests) → CommercialAssertion { ok, problems[], checks{
  policyCommercial, networkDenied, weightsVerified, noUserData }, modelResults }` (reuses `loadPolicy`
  + `verifyDriveModels`; flags network-allowed / plaintext / unverified-or-mismatch weights / present
  user data — `workspace/hilbertraum.sqlite[.enc]`, `config/workspace.json`, non-empty `workspace/documents/`).
✅ **`scripts/build-commercial-drive.{ps1,sh}`** — self-contained dual-shell master pipeline mirroring
  the plan; `-Target`/`--target` (req), `-AcceptLicense`/`--accept-license`, `-AppArtifact`/
  `--app-artifact` (a pre-built signed app to copy), `-SkipPackage`/`--skip-package`, `-DryRun`/
  `--dry-run`. Orchestrates prepare-drive (`-Force`) → fetch-models → fetch-runtime → (package =
  manual) → copy launchers+docs → verify-models `--generate` → native posture cross-check (exit 1 if
  not sellable). PS uses **hashtable** splatting for named params. Both dry-run-smoke-tested.
✅ **Packaging/signing** — `electron-builder.yml` `win.signtoolOptions` + `mac.notarize`/
  `hardenedRuntime`/`gatekeeperAssess:false`/`entitlements: build/entitlements.mac.plist`; secrets are
  env-driven + git-ignored. The green gate does NOT sign (it never runs electron-builder).
✅ **Tests** — `tests/integration/launcher.test.ts` (11: `resolveDriveRootFromLauncher` Win/POSIX/auto/
  empty/relative; `runPreflight` ok/slow/read-only/low-space/unmeasurable with an injected speed fn) +
  `tests/integration/commercial-drive.test.ts` (8: ordered plan + manual package + `--accept-license`
  threading + `formatPlan`; `assertCommercialDrive` passes verified-commercial, fails network/plaintext/
  placeholder-weight/user-data). **Signing + notarization + the real USB launch = manual (R5/R7).**

### MVP Definition of Done (§4 / spec §22) — checklist
| Criterion | Status |
|---|---|
| App builds on ≥1 OS | ✅ `npm run build` green (Windows) |
| Architecture supports Win/macOS/Linux | ✅ path/OS abstractions + 3 sidecar dirs + 3 builder targets |
| Local model chat works | ✅ mock now; real `LlamaRuntime` wired (live = manual, R5) |
| Local doc Q&A works | ✅ ingestion + embeddings + RAG (mock + real backends) |
| Citations work | ✅ Phase 6 (`citations_json`, source panel) |
| Manifests work | ✅ discover/validate/verify/recommend/select |
| Drive layout works | ✅ `prepare-drive` (dry-run tested); `resolvePaths` marker |
| User data local | ✅ no network in core path; loopback-only sidecars |
| Privacy docs exist | ✅ PRIVACY.md, Privacy screen, security-model |
| Setup script exists | ✅ `scripts/setup-dev.{ps1,sh}` |
| Benchmark recommendation exists | ✅ Phase 7 |
| Non-technical demo possible | ✅ documented end-to-end (user-guide.md); live run = manual (R5) |
| No cloud API | ✅ enforced (offline guard, CSP, deny-by-default policy) |
| No model weights in git | ✅ `.gitignore` (`models/`, `*.gguf`, `/runtime/`, `release/`) |
| README explains DIY | ✅ (+ user-guide + packaging + drive-layout) |
| Commercial drive layout documented | ✅ drive-layout.md + packaging.md |

**Remaining = MANUAL acceptance only (R2/R5):** producing the real portable `.exe` (Electron binary
download R2; npm-workspace dep hoisting may need a tweak) and a live USB-drive run with real weights +
sidecar binaries (not in repo). The selectors fall back to mocks when those files are absent, so dev +
CI are unaffected.

---


## 5. Next actions (do these next) — POST-MVP

**Everything shipped is summarized in §1/§3 and detailed in the design records. What remains:
manual release acceptance, one blocked phase (22), one drafted phase (30).** In rough priority:

> **Definition of Done (MVP, spec §22 — folded in from the retired `docs/IMPLEMENTATION_PLAN.md`):**
> app builds on ≥1 OS; architecture supports Win/macOS/Linux; local model chat works; local doc
> Q&A with citations works; manifests work; drive layout works; user data local; privacy docs
> exist; setup scripts exist; benchmark recommendation exists; non-technical demo possible; no
> cloud API; no model weights in git; README explains DIY; commercial drive layout documented.
> All code-verifiable items are ✅; the demo items are the manual acceptance below.

1. **Commercial-drive manual acceptance (needs certs + a real USB run, R5/R7):** obtain the
   code-signing certs (Windows OV/EV + Apple Developer ID), produce a **signed** Windows
   portable `.exe` + a **signed & notarized** macOS `.app`, run `build-commercial-drive`
   end-to-end onto a real drive (`-AppArtifact` the signed build), then do the spec §17 demo on
   a **fresh laptop with Wi-Fi off** + the **second-laptop continuity** check (same encrypted
   workspace, different drive letter). The `electron-builder.yml` hooks + the pipeline are
   wired; only the secrets + hardware are missing. **GPU additions:** a SmartScreen sanity
   re-check (the Vulkan build adds one more unsigned DLL of the same class) and re-running
   `build-commercial-drive` end-to-end with the two-build fetch. **Phase-38 addition:** a
   packaged-app OCR smoke (worker_threads cannot read asar — the `asarUnpack`/workerPath
   rewrite must be exercised in the built app).
1b. **GPU manual hardware matrix (THIS list is canonical — release acceptance, cannot be CI'd):**
   ① Win11 + discrete NVIDIA (dev box RTX 3080 Ti — ✅ done via the Phase-15 smoke; capture tok/s
   for release notes) · ② Win + discrete AMD (Adrenalin) · ③ Win laptop, Intel Iris Xe only
   (modest gain; profile does NOT bump) — **✅ done 2026-06-10 (i7-1185G7 + Iris Xe, `HILBERTRAUM_GPU_SMOKE`
   on `D:\`): probe sees "Intel(R) Iris(R) Xe Graphics" (8108 MiB), rung-1 starts as backend=gpu and
   streams, `gpuMode:off`→cpu, simulated rung-1 failure lands on the rung-3 CPU safety net; Iris Xe is
   integrated so `gpuUsefulForProfile` keeps the profile from bumping (unit-tested)** · ④ Win with no
   GPU / Server VM / RDP session (empty probe → silent CPU, no scary UI) · ⑤ Win with a pre-Vulkan-1.2
   GPU (clean rung-1 degradation) ·
   ⑥ Linux + NVIDIA and/or AMD (symlink-materialized libs load from exFAT) · ⑦ mac arm64
   regression (Metal unchanged) · ⑧ any GPU box: kill the driver mid-generation
   (`dxcap -forcetdr`) → §5.3 auto-fallback + friendly notice + next-message-works · ⑨ a
   `build-commercial-drive` drive moved between machines ①↔④ (flags/probe re-evaluate per machine;
   encrypted workspace continuity). The fake-spawn unit tests cover the *logic*; this matrix covers
   the *drivers*. Both are required before the release checkbox ticks.
2. **Small live-UI leftovers:** the Diagnostics **Activity-panel eyeball** on a real drive
   (events appear; export saves — the last wave-1 live-UI item); an icon/`buildResources` for
   electron-builder; the **optional** Phase-29 dev-box speed sweep (completeness only — QA +
   RSS are machine-independent).
3. **Phase 22 — signed offline update bundles** (spec §12.3): 🔴 blocked. Outline (kept here
   from the retired wave-1 record): a signed bundle (manifests + optionally weights/runtime/
   app) dropped into `updates/incoming/`, verified (ed25519 via the already-shipped `@noble`
   family — no new dep class), applied atomically, recorded in `updates/applied/` + the audit
   log. **Blocking decision = key management** (who holds the signing key, rotation, whether
   DIY drives trust a repo key) — needs its own short design doc before any code. The
   commercial pitch ("signed update bundles", spec §1.3) makes this the first priority once
   drives actually ship.
4. **Phase 30 — opt-in big slot + embeddings:** working paper drafted
   ([`docs/big-slot-embeddings-plan.md`](docs/big-slot-embeddings-plan.md), D38–D43): Track A
   (Gemma 4 26B-A4B etc. vs the incumbent Qwen3 30B-A3B, reusing the Phase-29 benchmark) +
   Track B (a better embedder — the reindex-forcing swap; D42 eval-set hardening is the
   prerequisite). Key verified fact: the pinned b9585 already runs Gemma 4 — no runtime bump.
5. **ANN vector index** only if a real corpus outgrows the linear scan (rag-design §12.2 D15 —
   explicitly not built).

**Current gate (2026-06-13, post i18n wave + FULL audit remediation — every HIGH/MEDIUM/LOW closed — on
branch `audit-2026-06-13-high-fixes`): typecheck clean, 1083 tests pass (25 skipped — the manual
tests behind `HILBERTRAUM_*` env vars: GPU/thinking/rerank/minsim/RAG-quality/bring-up/
eval/concurrency-probe/translation/compare/whisper/dictation/OCR smokes — skipped in CI),
`npm run build` green. Full-suite runs on a loaded machine can flake 1–2 timeout failures
(different tests each run; each passes in isolation — see the §3 2026-06-13 entry).** Per-phase gate history (test counts, bundle sizes, per-phase test
inventories) lives in git history.

---

## 6. Open issues / risks

- **R1 `node:sqlite` ✅ RESOLVED** — works in Electron 37 (Node 22.21) main process and in
  vitest (system Node); bundler resolution via `createRequire` in `db.ts`; the `sql.js`
  fallback was never needed.
- **R2 Electron binary download** — `npm i electron` and electron-builder packaging need
  dev-time network; the *app* stays offline. ⚠️ npm-workspace hoisting: prod deps live in the
  **root** `node_modules`; if electron-builder can't collect them, build from `apps/desktop`
  or adjust hoisting.
- **R3 PDF/DOCX parsers ✅ RESOLVED** — pdfjs legacy build runs in the Node main process (no
  worker/DOM); `mammoth`/`papaparse` pure-JS; all three externalized
  (`externalizeDepsPlugin`). Ambient typings in `parsers/pdfjs.d.ts`.
- **R4 Argon2id ✅ RESOLVED** — new vaults use pure-JS `@noble/hashes` Argon2id; scrypt vaults
  unlock unchanged forever (the descriptor records `algo` + params; see the §3 KDF decision).
- **R5 Real llama.cpp ⚠️ PARTIALLY RESOLVED** — all mechanics are implemented + tested against
  mocked processes/fetch, and every real-hardware smoke (`HILBERTRAUM_*`) has passed on provisioned
  drives; but binaries/weights are not in the repo, so the live spec-§17 demo from a real
  commercial drive remains the one manual acceptance step.
- **R6 TLS-intercepting proxy on this machine** — `npm install` fails with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (corporate root CA). Workaround:
  `NODE_OPTIONS=--use-system-ca npm install` (Node 24 reads the Windows cert store). Dev-only;
  the app stays offline.
- **R7 Code-signing certificates — PROCUREMENT, blocks only the *commercial* acceptance.**
  The `electron-builder.yml` hooks are wired (win signtool, mac notarize + hardened runtime +
  entitlements) and driven by env vars / a git-ignored secrets file; the OV/EV Windows cert +
  Apple Developer ID cost money + lead time. The green gate does NOT sign; the DIY path uses
  the unsigned "Run anyway" fallback (`docs/troubleshooting.md`).

---

## 7. Conventions

- IDs: UUID v4 (`crypto.randomUUID()`). Timestamps: ISO-8601 UTC.
- No network in core path. No telemetry. Models/workspace/logs are git-ignored.
- Every service hides behind an interface from spec §9.2 to keep the Tauri/Rust swap open.

---

## 8. Post-MVP audits & hardening (2026-06-09 → 2026-06-10) — ALL REMEDIATED

After Phase 13, four multi-persona audit rounds (security/privacy · spec-compliance · bug-hunt ·
docs-vs-code · release/build engineering) reviewed the full repo. **Every Critical, High, and Medium
finding plus the actionable Lows were fixed** across six remediation waves. The detailed
per-finding records and the final audit report were removed in the 2026-06-10 docs cleanup — they
live in git history (`docs/audit-2026-06-09-multi-persona.md` and BUILD_STATE §8–§14 before this
commit). Highlights of what was fixed:

- **Security / data-loss:** encrypted document cache (spec §3.5 — stored copies are `.enc` in an
  encrypted workspace, with transient decrypts shredded after parsing); vault-wipe guards (`create`
  refuses over any existing vault artifact; a corrupt descriptor reports `locked`, never
  `uninitialized`); streaming file crypto + chunked shred (> 2 GiB safe); KDF param bounds-checking;
  key zeroing on lock; startup sweep of crash leftovers (`.tmp`/`.parse*`/WAL/SHM).
- **Process lifecycle:** `RuntimeManager` start/stop serialized through an op queue;
  `E5Embedder.stop()` awaits an in-flight lazy start; SIGKILL escalation gated on actual exit;
  awaited `will-quit` stops — every orphaned-`llama-server` path closed.
- **Commercial pipeline:** `fetch-runtime` sha256 parsing fixed (the key regex was structurally
  dead in both shells); `verify-models --strict` weight gate wired into `build-commercial-drive`
  step 7 (a placeholder-hash drive now exits 1); per-OS sidecar loop (one drive ships win+mac+linux);
  license-review ship gate (`checks.licensesApproved`, NOT overridable by `--accept-license`).
- **Correctness cluster:** regenerate-after-failure, conversation-switch-mid-stream,
  per-document concurrency, and lock-while-importing races; DOCX chunk packing (coalesce
  same-label segments); E5 context truncation + batching + request timeouts; checksum verification
  cached on `(path, size, mtimeMs)` (no more multi-GB re-hashing per screen mount); the spec §7.4
  model gate enforced in the MAIN process (role + install state + policy); `developerMode` defaults
  to **false**.
- **Spec completions:** automatic first-run benchmark (§2.1); chat transcript export (§7.6); full
  Diagnostics incl. local log viewer (§7.11); drive detection without the launcher
  (`config/drive.json` marker walk-up from the exe location, §7.2).
- **Manual-acceptance prep (2026-06-10):** `runtime-sources.yaml` pinned to the REAL release
  **`ggml-org/llama.cpp@b9585`** (real per-OS URLs + SHA-256 checksums, verified end-to-end from a
  Windows host for all three OSes; tar.gz + symlink-materialization + flatten handling in
  `fetch-runtime`; schannel `--ssl-revoke-best-effort` proxy fix). **License reviews COMPLETED**
  (spec §13): all six manifests are `license_review.status: approved` (Qwen3 GGUFs = apache-2.0;
  E5 = MIT via the base model, caveat recorded in the manifest notes).

Final gate: typecheck clean, **361/361 tests**, build green, no new runtime deps.

**Still open by choice:** the consciously-accepted items are documented in
[`docs/known-limitations.md`](docs/known-limitations.md) (that list is live; several
MVP-era examples from this audit — the depth-mode plumbing, `runtime_events` — have
since shipped in Phases 19–20).

### Open hardening items — security audit 2026-06-13 (deferred, NOT yet fixed)

The 2026-06-13 hardening wave fixed every MEDIUM + the quick-win LOWs (see the entry at the
top of this file; the full audit report is in git history at commit `f99bc86`). These four
LOW items were consciously deferred — they are defense-in-depth / build-pipeline, none blocks
the offline/privacy guarantees:

- **L-4 — `importDocuments` trusts renderer-supplied source paths.** The handler type-filters +
  unlock-gates, but the path *values* are not constrained to the OS-picker output, so a
  compromised renderer could ingest any user-readable absolute path (arbitrary local-file *read*,
  no traversal *write*). Fix: have `pickDocuments` return **opaque tokens** that `importDocuments`
  redeems, instead of trusting renderer-supplied paths. (Discuss before implementing — it changes
  the import IPC contract.)
- **L-5 — `expandPaths` follows directory symlinks.** `walk()` uses `statSync` (follows links) with
  no cycle guard, so a picked folder with a symlink to e.g. `C:\Windows` traverses outside the
  selection. Blast radius: "indexes files the user didn't intend" (supported extensions only), not
  RCE. Fix: `lstatSync` for directory entries (skip symlinks) or a visited-realpath cycle guard.
- **L-7 — Runtime-archive extraction doesn't prevent member traversal (build-time only).**
  `Expand-Archive` / `tar -xzf` in `scripts/fetch-runtime.{ps1,sh}` run on the drive **builder's**
  trusted machine, not the shipped app. A crafted archive (attacker controlling both URL and its
  placeholder hash) could write outside `extract_to`. Fix: list/extract members with an explicit
  containment check.
- **L-8 — Lockfile / `npm ci` discipline.** Confirm `package-lock.json` is committed and the
  provisioning/build scripts use `npm ci` (not `npm install`) so a build can't float a caret range
  to a newer minor. Integrity anchor = the committed lockfile.

---

## 9. First real Windows `D:\` drive bring-up — durable lessons (2026-06-10)

The first real-drive provisioning + RAG run surfaced a cluster of provisioning, path,
manifest-source and embedding bugs — all fixed same-day (the full narrative is in git
history). What still matters:

- **PowerShell arg forwarding = hashtable splatting, never array splatting.**
  `@('-Target', $t, '-AcceptLicense')` binds positionally (the `-`-prefixed string is NOT a
  parameter name), which broke `prepare-drive -WithAssets`. Convention recorded in §3;
  both call sites use hashtables now.
- **Bare-drive-root containment false positive:** `resolve('D:\')` keeps the trailing
  separator, so the `base + sep` prefix check doubled it (`D:\\`) and rejected every
  legitimate weight — latent because only a real drive-root launch hits it.
  `weightPath`/`resolveWithinRoot` normalize (`prefix = base.endsWith(sep) ? base : base + sep`);
  regression-tested with a real root (`parse(process.cwd()).root`).
- **Hash promotion is durable only in the REPO manifests:** `verify-models --generate` writes
  `config/checksums.json`, never the manifest `sha256`, and any `prepare-drive` re-run
  overwrites drive-local manifest edits. Promote real hashes into the repo manifest, then
  re-sync to the drive.
- **Broken upstream sources found by the fetch:** `qwen3-1.7b-instruct-q4` → 404 (the official
  repo ships no Q4_K_M) — manifest **dropped**; the 4B took over TINY/UNKNOWN
  (`recommended_profiles`). `multilingual-e5-small` quant repo went 401 — switched to the
  `cstr/` mirror, provenance recorded in the manifest license note.
- **The E5 embedder GGUF must be F16 on b9585** (the failure mode
  `tests/manual/rerank-smoke.test.ts` guards against): q8_0 builds either lack
  `token_type_count` (BERT/XLM-R metadata) or crash warmup
  (`binary_op: unsupported types: dst f32, src1 q8_0`). Shipped
  `keisuke-miyako/multilingual-e5-small-gguf-f16` (242 MB, 384-dim, VERIFIED); the `-q8`
  manifest id is kept as the opaque vector tag.
- **The first real-drive hallucination was the plain-Chat tab, not the RAG engine** — the
  question never reached retrieval (the grounded path has a hard empty-corpus guard). This
  finding motivated Phase 17 (rag-design.md §10). Related: a document ingested under the
  mock embedder is invisible to E5 retrieval (vectors are scoped by `embedder.id`) —
  re-upload/re-index after an embedder change.
