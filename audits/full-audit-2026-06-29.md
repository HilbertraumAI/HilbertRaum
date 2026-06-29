# Full multi-perspective audit — HilbertRaum — 2026-06-29

> Fresh audit performed after the 2026-06-28 full audit was fully remediated and merged (PR #12).
> Method: 7 parallel domain reviews (security, RAG/ingestion, backend reliability, renderer,
> testing, docs, financial/business-logic) over the real source tree, with the top findings
> re-verified firsthand by the lead auditor (regex traces, full-suite run, doc/code diffs).
> Posture preserved: offline / no-telemetry / local-only.

---

## 1. Executive summary

**Overall health: strong.** This is a mature, unusually well-hardened codebase. Five prior remediated
audits show in the density of cited defensive controls, the "teeth-check" (neuter→fail→restore) test
discipline, and the stable §-anchored design records. The classic failure classes a fresh auditor
expects to find broken — zip/tar-slip, ReDoS, vault crypto, sidecar binary verification, reranker
truncation, FTS/VACUUM desync, GPU crash recovery, transaction atomicity — are all genuinely closed
and held up under scrutiny. Most areas reviewed were **clean**.

**The audit nonetheless found two issues that should be fixed before the next release:**

1. **A confirmed financial-correctness bug (High):** the shared money regex steals a leading-minus
   sign from the next figure, flipping *both* the amount and the running balance on any statement that
   prints a negative figure with a leading minus — and the balance-reconciliation safety net **cannot
   detect it** because both figures flip consistently. Verified by direct regex trace. This produces
   *wrong numbers*, silently, on the app's headline feature (bank-statement extraction).

2. **The test suite is intermittently red (High):** a polling loop introduced yesterday (commit
   `fa9a6b2`, PERF-2) is bounded by iteration count instead of wall-clock and flakes under full-suite
   CPU load. Reproduced during this audit. `BUILD_STATE.md`'s "2417 passed" green claim is therefore
   stale/optimistic.

**Highest-priority risks**
- Wrong financial figures on negative-balance / leading-minus statements (BL-1).
- CI/`green` trust eroded by a load-induced flake (TEST-1).
- A single currency token in a payee description silently suppresses all totals (BL-2) — a usability
  cliff on ordinary single-currency statements.
- German closed-compound descriptions defeat the deterministic categorizer for the *de-AT target locale*
  (BL-3) — fees mis-bucketed.

**Biggest opportunities**
- Close the **enforcement-vs-correctness** test gaps: the binary-verifier and embed-failure paths are
  correct in isolation but nothing proves they remain *wired* (a silent unwiring would redden no test).
- Make the resident-vector cache **incremental** instead of full-rebuild-per-write (the real
  scalability ceiling at ~100k chunks).
- A handful of cheap determinism/robustness fixes (tie-break ordering, surrogate-safe snippet, renderer
  unmount guards) and four small doc drifts.

**Scale of effort:** no Critical findings; 2 High, ~9 Medium, ~13 Low. All fixable in small, isolated
phases that fit the project's per-phase ritual. The financial bug (BL-1) and the flake (TEST-1) are the
only two that warrant urgency.

---

## 2. Findings

Severity = user/data impact. Confidence = how sure the finding is real. IDs are used by the phase plan.

### HIGH

---

#### BL-1 — Sign-theft: a leading-minus figure steals the previous figure's sign; reconciliation can't catch it
- **Category:** Business logic / financial correctness · **Severity:** High · **Confidence:** High (verified by direct trace)
- **Location:** `apps/desktop/src/main/services/skills/tools/money.ts:62` (`MONEY_RE`), surfacing in
  `tools/bank-statement.ts:129-151` (`parseLine`) and `tools/invoice.ts` (`parseLineItem`).
- **Description.** `MONEY_RE` ends in `…(?!\d)\s*\)?-?`. The trailing `-?` exists to catch the de-AT
  *trailing* minus (`500,00-`). But when the **next** column is a money token written with a *leading*
  minus, that trailing `-?` greedily consumes the next token's `-` across the separating space. The
  first figure gains a spurious minus; the second loses its real minus.
- **Evidence (verified firsthand).** Trace `MONEY_RE` over `"2.500,00 -500,00"`:
  - Token 1 = `"2.500,00 -"` (the magnitude `2.500,00`, then `\s*` eats the space, then `-?` eats the
    next token's leading minus). `parseAmount("2.500,00 -")` → `/-\s*$/.test(s)` is true → **−2500**.
  - Token 2 = `"500,00"` → **+500**.
  - `parseLine` sets `amount = parseAmount(tokens[len-2]) = −2500`, `balanceAfter = parseAmount(tokens[len-1]) = +500`.
  - Correct: `amount = +2500`, `balanceAfter = −500`. A **+€2500 credit became a −€2500 debit**, and a
    **−€500 overdraft became +€500**.
- **Why the safety net misses it.** Because *every* amount and *every* balance flips consistently, the
  running-balance chain (`prevBalance + amount == balanceAfter`) stays internally consistent, so
  `reconcileBalances` reports `ok` and `assessCompleteness` gives a false green. `summarizeCashflow`
  then reports inflow as outflow; the CSV export and categorization are all mis-signed.
- **Trigger / reach.** Any statement that prints a **negative running balance** or a **leading-minus
  amount** in the second-or-later figure column: overdrawn accounts, US/international statements, and
  the PDF-geometry path (a negative balance is classified `money` and emitted verbatim, then re-joined
  with a space → same collision). The team's own bank-statement fixtures **never use a negative
  balance**, which is why this slipped past the BL-N* round.
- **Consequences.** Wrong sign on the cardinal figures (amount, balance, net cashflow, overdraft),
  with a falsely-passing reconciliation — the worst kind of financial bug (confidently wrong).
- **Recommended fix.** Stop the trailing `-?` from firing when another number immediately follows.
  Either drop the trailing `-?` and detect a genuine trailing minus only when it is *not* the start of
  the next token, or add a guard so it does not consume across a following figure, e.g.
  `…(?!\d)\s*\)?(?:-(?!\s*[-+((]?\d))?`. Re-verify the de-AT trailing-minus fixtures still pass.
- **Testing needed.** Add fixtures with a **negative running balance** (`'… 2.500,00 -500,00'` credit
  into overdraft; `'… -45,90 -1.954,10'`), assert `amount`/`balanceAfter` signs and that
  `reconcileBalances` stays `ok`. Teeth: revert the regex → the new fixtures must fail.
- **Docs.** Note the leading-minus support in `docs/architecture.md` "Skills — design record" §8 money
  notes and add a known-limitations entry if any residual remains.

---

#### TEST-1 — The test suite is intermittently RED: an iteration-capped poll flakes under full-suite load
- **Category:** Testing / reliability · **Severity:** High · **Confidence:** High (reproduced during audit)
- **Location:** `apps/desktop/tests/integration/dictation-ipc.test.ts:223`.
- **Description.** Commit `fa9a6b2` (2026-06-29, PERF-2) moved `await writeFile` to run *before*
  `transcribe()`. The test compensates with a poll that is capped by **iteration count**, not wall-clock:
  ```js
  for (let i = 0; calls === 0 && i < 100; i++) await new Promise((r) => setImmediate(r))
  expect(calls).toBe(1)
  ```
- **Evidence.** Running `npm test` end-to-end during this audit failed here (`expected +0 to be 1`); the
  test passes in isolation (3× green). Textbook load-induced flake: under CPU contention in vitest's
  forked pool, the off-event-loop `writeFile` does not complete within 100 `setImmediate` ticks, so
  `calls` is still 0. **Every other integration polling loop uses a generous wall-clock deadline**
  (`if (Date.now() - start > 5000) throw`); this is the lone iteration-capped one.
- **Consequences.** False-red CI; eroded trust in "green"; `BUILD_STATE.md`'s "2417 passed / 39 skipped"
  is stale (a fresh run is 2416 passed + 1 flaky-fail, ~2456 tests collected). The full-suite guard
  protects against dropped *files*, not against this.
- **Recommended fix.** Replace the iteration cap with a wall-clock deadline matching the rest of the
  suite: `const start = Date.now(); while (calls === 0 && Date.now() - start < 5000) await new Promise((r) => setImmediate(r))`.
  The synchronous-`inFlight` BUSY-refusal assertion below it is fine and unaffected.
- **Testing needed.** Re-run the full suite 3× after the fix to confirm stability.
- **Docs.** Refresh the `BUILD_STATE.md` test-count headline after the green run.

---

### MEDIUM

---

#### BL-2 — A currency token in any payee/description silently disables all totals & reconciliation
- **Category:** Business logic · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/tools/bank-statement.ts:143` —
  `const currency = detectCurrency(line) ?? statementCurrency`.
- **Description.** Per-row detection takes precedence over the statement currency, and `detectCurrency`
  (`money.ts:21`) scans the **whole line including the description** for an allowlisted ISO code or a
  symbol (`€ $ £ ¥`). One transaction whose memo contains `USD`/`$`/etc. gets tagged with that currency.
- **Evidence.** For a EUR statement, the row `"2026-01-04 Netflix USD subscription -12,99 1.200,00"` →
  `detectCurrency(...) === 'USD'` → `row.currency = 'USD'`. Now `new Set(rows.map(r=>r.currency)).size > 1`,
  which trips the BL-2/BL-3 single-currency guards: `summarizeCashflow` returns no `currency`
  (→ "no single total"), `reconcileBalances` marks **every** row `unknown` (no balance validation at
  all), and `assessCompleteness` downgrades to `unverified`.
- **Consequences.** The user asks "what's my total spend?" and gets a mixed-currency refusal on an
  ordinary single-currency statement. Silent — no indication that one description string caused it.
- **Recommended fix.** Prefer the statement currency: `statementCurrency ?? detectCurrency(line)`. If
  genuine per-row foreign-currency is wanted, detect the currency only in the **figure region** (right
  of the amount), not in the free-text description — mirror how `pdf-layout.ts` separates a standalone
  currency cell.
- **Testing needed.** Fixture: EUR statement with `USD`/`$` in a description → totals/reconciliation
  still computed in EUR. Plus keep a genuinely-mixed-currency fixture asserting the honest refusal.

---

#### BL-3 — German closed-compounds defeat the deterministic categorizer (de-AT is the target locale)
- **Category:** Business logic · **Severity:** Medium · **Confidence:** High (verified by trace)
- **Location:** `apps/desktop/src/main/services/skills/tools/money.ts:237` (`wordIncludes`), used by
  `categorizeRow` (`bank-statement.ts:619`) and `prefilterCategory` (`categorizer.ts:156`).
- **Description.** The C-1 fix replaced raw `includes` with a Unicode word-boundary test (needle must be
  flanked by non-letter/digit on both sides) to stop `fee ⊂ coffee`. But German forms closed compounds,
  so the keyword never sits on a boundary in real descriptions.
- **Evidence (verified).** `wordIncludes("kontoführungsgebühr","gebühr") === false` (the `gebühr` is
  preceded by `s`); likewise `bankgebühr`/`gebühr`, `gehaltszahlung`/`gehalt`, `monatslohn`/`lohn` all
  return false. Account-maintenance/bank **fees** therefore fall through to the generic
  negative→"Spending" bucket instead of "Fees"; `überweisung`/`sepa`/`transfer` compounds similarly
  miss. (Salary mostly survives via the positive-amount sign fallback, so income is less affected.)
- **Consequences.** Category breakdowns are materially wrong for typical Austrian/German statements —
  the stated target market. The LLM pre-filter degrades identically (those rows go to the model instead
  of being confidently pre-bucketed: wasted, not wrong).
- **Recommended fix.** For the German keyword list, allow a one-sided boundary (suffix/prefix compound
  match) or a plain substring match, while keeping the strict two-sided boundary for short English
  tokens (`fee`/`atm`) where false positives are the real risk.
- **Testing needed.** Fixtures: `Kontoführungsgebühr`→Fees, `Bankgebühr`→Fees, `SEPA-Überweisung`→Transfer.

---

#### REL-1 — `findFreePort` → spawn TOCTOU can mis-attribute a port race to "GPU broke" and persist `gpuAutoDisabled`
- **Category:** Reliability · **Severity:** Medium · **Confidence:** High (race real; impact bounded)
- **Location:** `apps/desktop/src/main/services/runtime/sidecar.ts:103-113` (`findFreePort`),
  `doStart` (`:351-432`).
- **Description.** `findFreePort` binds port 0, reads the assigned port, **closes** the listener, then
  passes the number to `llama-server --port N`. Between the close and the child binding, another process
  — or another concurrent in-app sidecar start (chat + embedder + reranker + vision can start nearly
  simultaneously) — can grab it. The child then exits with `bind: address already in use`, and
  `waitForHealthy` throws "exited before becoming healthy."
- **Consequences.** Rare spurious start failures. Worse: for the **chat** runtime the ladder treats a
  rung-1 failure as a GPU failure and persists `gpuAutoDisabled`, so a transient *port* race disables
  GPU for the session. For e5/reranker/vision there's no retry — the embed/rerank/analyze just fails.
- **Recommended fix.** Retry the spawn once on an immediate bind-class exit before declaring the rung
  failed; and don't persist `gpuAutoDisabled` when the failure stderr matches a bind error rather than
  a device/driver failure (narrow `onGpuFailure`).
- **Testing needed.** Unit test: a rung whose child exits immediately with an `EADDRINUSE`-style stderr
  retries once and does **not** persist `gpuAutoDisabled`.

---

#### REL-2 — Whisper watchdog/abort never escalates to SIGKILL → a wedged child can hang quit/lock
- **Category:** Reliability · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/transcriber/cli.ts:236-246, 263-272, 307-318`.
- **Description.** The inactivity watchdog and the abort handler call bare `child.kill()` (SIGTERM) and
  rely on the `close` event to settle the promise — with **no SIGKILL escalation**, unlike
  `LlamaServer.stop()` which races a grace window and escalates (`sidecar.ts:497-509`). A `whisper-cli`
  wedged in native code that ignores SIGTERM never emits `close`, so the watchdog "fires" but the slot
  stays held; and `suspend()`/`stop()` on workspace-lock/quit `await Promise.all(pending…)`, which
  resolves only via `close`.
- **Consequences.** A SIGTERM-ignoring whisper child can wedge the ingestion slot and **block quit/lock
  teardown indefinitely**, leaving the un-shredded transcript transient on disk.
- **Recommended fix.** Mirror `LlamaServer.stop()`: after `kill()`, race a grace window and escalate to
  `child.kill('SIGKILL')`; bound the `await` in `suspend()`/`stop()` with a timeout.
- **Testing needed.** Harness a fake child that ignores SIGTERM; assert `stop()` resolves within the
  grace+kill window and the child receives SIGKILL.

---

#### REL-3 — "Stop" cancellation is unresponsive while a deep-index build holds the model slot
- **Category:** Reliability / UX · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/ipc/chat-stream.ts:95-122`, `model-slot-arbiter.ts:108-123`.
- **Description.** `withChatStream` registers the in-flight `AbortController` and then `await`s
  `acquireSlot()`, which parks until the tree-builder reaches a node boundary. The builder parks only
  *between* `generate` calls; a single node's `generate` is a multi-second CPU summarization. During
  that window the controller's signal is not threaded into anything `acquireForChat` observes (it has no
  signal parameter), so `stopGeneration` aborts a controller nobody is watching.
- **Consequences.** "Stop" on a chat message appears dead for up to one tree-node summarization while a
  deep-index build runs. Not a leak (it unwinds eventually), but a real cancellation-latency bug under
  concurrency.
- **Recommended fix.** Thread `controller.signal` into `acquireSlot`/`acquireForChat` and reject the
  handoff wait on abort so a Stop during the park unwinds immediately.
- **Testing needed.** Integration: start a chat turn while a build holds the slot, abort, assert the
  turn rejects/clears promptly without waiting for the build node.

---

#### PERF-1 — Resident-vector cache fully rebuilds on every embeddings write (main-thread block at scale)
- **Category:** Performance / scalability · **Severity:** Medium (at ~100k chunks) · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/embeddings/resident-cache.ts:88-101`; invalidation hooks
  at `ingestion/index.ts:770,918`.
- **Description.** Every embeddings INSERT/DELETE calls `invalidateResidentVectors`, so the **next**
  `search` rebuilds the whole `Map<chunkId,Float32Array>` by selecting and decoding *all* embedding rows
  synchronously on the Electron main process. At the ~100k-vector ceiling that is the documented ~150 MB
  read + decode (~580 ms) blocking the UI — and it recurs after *every* import/re-index/delete, so a
  heavy import session (import N docs, ask a question between each) pays N full rebuilds. (The linear-scan
  ANN deferral D15 is acknowledged; the *per-write full invalidation* is the sharper edge.)
- **Consequences.** UI jank / multi-hundred-ms stalls that grow with corpus size and import frequency.
- **Recommended fix.** Incremental cache maintenance: on the invalidation hook, decode only the
  newly-inserted rows and delete removed ids from the existing map instead of dropping it. (The
  documented P4b off-main-thread worker / P4c ANN remain the longer-term paths.)
- **Testing needed.** Unit: after an insert of K new vectors the cache contains old+new without a full
  re-decode (spy the decode call count); after a delete the ids are gone. Bench note in the design record.

---

#### TEST-2 — Binary-verifier is correct in isolation, but no test proves the spawn seams still *call* it
- **Category:** Testing (security regression blind spot) · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/tests/unit/binary-verifier.test.ts` (verdict matrix well-tested);
  no integration test at the `LlamaServer.start` / GPU-probe / whisper spawn seams.
- **Description.** The verifier's verdict/cache semantics are excellently covered, but nothing asserts
  that a spawn is **refused** when the marker hash mismatches. A regression that silently stopped calling
  `verifyBinaryBeforeSpawn` before a spawn would redden **no** test — the re-hash-before-spawn control
  (vuln-scan-2026-06-21 item B) could be fully correct and fully unwired.
- **Consequences.** The headline supply-chain control could regress undetected.
- **Recommended fix.** One integration test per seam (the `FakeChild`/`llama-runtime` harness already
  provides the seam) asserting spawn is refused on a marker-hash mismatch in packaged mode.
- **Testing needed.** As above; teeth-check by removing the verify call → test fails.

---

#### TEST-3 — Embed-failure propagation is proven at `retrieve()` but not at `generateGroundedAnswer()` / the UI
- **Category:** Testing · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/tests/integration/rag.test.ts:385-399` (covers `retrieve`); no coverage at
  `rag/index.ts` `generateGroundedAnswer` or any renderer/IPC test.
- **Description.** TEST-N8 correctly proves `retrieve()` rejects on a failing embedder. But
  `generateGroundedAnswer` `await`s `retrieve` and has an early-return for empty chunks
  (`NO_DOCUMENT_CONTEXT`/`REINDEX_NEEDED`). A regression wrapping `retrieve` in `try/catch → []` would
  make a transient embed fault **masquerade as "no documents"** with no test catching it, and the
  user-visible surface (friendly error vs. silent "no documents") is untested.
- **Recommended fix.** Add a `generateGroundedAnswer`-level test with a failing embedder asserting it
  rejects (does not return the no-context answer); optionally a ChatScreen renderer test for the error path.

---

#### DOC-1 — `collections.ts` header claims a shipped feature is "left out of v1" and cites the wrong §
- **Category:** Documentation (misleads agents) · **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/collections.ts:21-22`.
- **Description.** The header says delete-with-documents "is the one piece **left out of v1**
  (rag-design.md §13.7)." But (a) the feature **shipped in the same file** — `projectOnlyDocumentIds`
  at `collections.ts:209` is exactly the C2 predicate, documented as built in `architecture.md` §1 C2
  (`:1925`); and (b) `rag-design.md §13.7` is about scope persistence / smart-views, not
  delete-with-documents. A future agent reading the header would conclude the capability doesn't exist.
- **Recommended fix.** Drop the "left out of v1" clause and repoint the reference to `architecture.md`
  §1 C2 (or, if a deferred item is meant, cite the genuinely-deferred smart-view-as-scope persistence).

---

### LOW

---

#### SEC-1 — No rate-limiting / strength floor on vault unlock; the offline-guessing residual is undocumented
- **Category:** Security · **Severity:** Low · **Confidence:** High
- **Location:** `registerWorkspaceIpc.ts:56-100` (`unlockWorkspace`, `MIN_PASSWORD_LENGTH = 8`);
  `workspace-vault.ts:646-683`; KDF params in `security/crypto.ts:51-57` (Argon2id `m=19MiB,t=2,p=1`).
- **Description.** Unlock has no attempt counter, delay, or lockout, and the only password floor is
  length-8. Against the explicitly-modeled lost/stolen-drive threat (`security-model.md:21`), a
  weak-but-≥8 password is realistically crackable offline at the interactive-minimum KDF cost. The
  at-rest Argon2id encryption is the primary mitigation and this is a defensible offline trade-off — but
  it is **not** recorded as an accepted residual in `security-model.md`.
- **Recommended fix.** Add an escalating-delay/attempt counter on the IPC unlock path (cheap defense
  against scripted GUI guessing) and a strength meter/floor at create/change time; **document the
  offline-guessing residual explicitly** in `security-model.md` either way.

---

#### RAG-1 — Tied vector/keyword scores get nondeterministic per-list ranks before RRF fusion
- **Category:** Correctness / reproducibility · **Severity:** Low · **Confidence:** High
- **Location:** `embeddings/index.ts:222` (`hits.sort((a,b)=>b.score-a.score)` — no id tiebreak),
  `rag/hybrid.ts` FTS `ORDER BY bm25(...)` (no rowid tiebreak).
- **Description.** Neither input list has a secondary tiebreak on equal scores. Under prefix-less E5 the
  cosines compress into a narrow band (§12.1 R3), so ties are realistic; the *per-list rank* a chunk
  receives (which drives its RRF contribution) then depends on V8 sort stability + SQLite's unspecified
  tie order. `rrfFuse` breaks the *final* tie on `chunkId`, but which chunk wins a page-dedup slot can
  still flip across SQLite versions/query plans — a reproducibility/test-flake risk, not a hallucination.
- **Recommended fix.** Add `, chunk_id` to the FTS `ORDER BY` and a `chunkId` tiebreak to the vector sort.

---

#### RAG-2 — `truncateSnippet` can split a surrogate pair, emitting `…` after half a code point
- **Category:** Correctness (display) · **Severity:** Low · **Confidence:** High
- **Location:** `rag/index.ts:338-341` — `trimmed.slice(0, SNIPPET_MAX_CHARS)`.
- **Description.** `String.slice` cuts at a UTF-16 code unit; if char 600 falls inside an astral
  character (emoji, CJK ext-B, math symbols), the citation snippet ends in a lone surrogate (`�`).
  Display-only; never corrupts stored chunk text.
- **Recommended fix.** `[...trimmed].slice(0, N).join('')`, or trim back to the last non-surrogate boundary.

---

#### FE-1 — ChatScreen does setState-after-unmount in the attach-job poll and stream-flush (no mountedRef guard)
- **Category:** Frontend · **Severity:** Low · **Confidence:** High
- **Location:** `renderer/screens/ChatScreen.tsx:1034-1075` (`watchAttachJob`), `:240-263, 798-875`
  (stream flush); unmount effect at `:381-385`.
- **Description.** Unlike DocumentsScreen/DiagnosticsTab (hardened under FE-4 with `mountedRef`),
  ChatScreen's attach-import poll and streamed-token flush call `setPendingImport`/`setDocs`/`setError`/
  `setStreamText` on async resolution after the user navigates away mid-import/mid-generation. Benign
  under React 18 (no warning) but it's the exact FE-4 class the sibling screens guard, and the stream
  path leaks a short-lived `flushTimer`. (Do **not** tear down the main-side stream — it's intentionally
  recovered via `getActiveStream`; just guard the setStates and clear the timer on unmount.)
- **Recommended fix.** Add a `mountedRef`, gate the poll/flush setStates behind it, and
  `useEffect(() => () => clearStreamBuffers(), [])`.

---

#### REL-4 — `combineSignals` accrues per-request `AbortSignal.timeout` timers under heavy ingestion
- **Category:** Reliability · **Severity:** Low · **Confidence:** Medium
- **Location:** `runtime/sidecar.ts:123-126`.
- **Description.** Each embed/rerank/vision request builds `AbortSignal.timeout(ms)` +
  `AbortSignal.any([caller, timeout])`; when the request completes early (the norm) the timer is not
  cleared and lives out its full `ms` (120 s embed/rerank, 300 s vision). A large ingestion (hundreds of
  embed batches) accrues thousands of pending timers + composite signals before they age out.
  Self-limiting (timeouts are unref'd, so they don't block quit), but avoidable churn, and a long-lived
  `caller` holds the `any`-listener until each timeout fires.
- **Recommended fix.** Build from an `AbortController` + explicit `setTimeout` `clearTimeout`'d in a
  `finally` around the fetch.

---

#### REL-5 — Write transactions use `BEGIN` (DEFERRED), not `BEGIN IMMEDIATE`; no poisoned-connection guard
- **Category:** Reliability · **Severity:** Low · **Confidence:** Medium (defense-in-depth)
- **Location:** all `db.exec('BEGIN')` sites (`chat.ts:699`, `doctasks/manager.ts:1627`,
  `tree-build.ts:171,255`, `node-vectors.ts:156`, `skills/run.ts:231`, …).
- **Description.** DEFERRED transactions that start read-only and later upgrade to write can hit
  `SQLITE_BUSY_SNAPSHOT` that `busy_timeout` does not retry. The wrappers correctly `ROLLBACK` on throw
  (degrades to a failed op, not corruption — and the important invariant, *no `await` between BEGIN and
  COMMIT*, holds everywhere checked), so this is latent rather than a confirmed bug. Separately, a throw
  between `BEGIN` and the `try` (or a throwing `COMMIT`) could leave an open transaction and cascade
  "cannot start a transaction within a transaction" on the shared connection.
- **Recommended fix.** Use `BEGIN IMMEDIATE` for write transactions; route through a single
  `withTransaction(db, fn)` helper that asserts no transaction is open and force-resets a poisoned one.

---

#### DOC-2 — `architecture.md` GPU table says "60 s health timeout"; code uses 180 s (3× understated)
- **Severity:** Low · **Confidence:** High
- **Location:** `docs/architecture.md:1622` vs `runtime/sidecar.ts:207`
  (`DEFAULT_HEALTH_TIMEOUT_MS = 180_000`, applied at `:270`; chat runtime never overrides it; no `60_000`
  exists in main). A hung GPU driver stalls the first start for **180 s**, not 60 s.
- **Recommended fix.** Change "60 s" → "180 s (3 min)" (or reference `DEFAULT_HEALTH_TIMEOUT_MS`).

---

#### DOC-3 — BGE reranker size is GiB-mislabeled-as-GB (`1.08` vs decimal `1.16`)
- **Severity:** Low · **Confidence:** High
- **Location:** `model-manifests/reranker/bge-reranker-v2-m3.yaml:8` (`size_on_disk_gb: 1.08`) vs
  `download.size_bytes: 1159776896` (= 1.16 GB decimal / 1.080 GiB); `docs/model-policy.md:33` inherits
  "~1.08 GB". This is the lone manifest using GiB where the other twelve use decimal GB.
- **Recommended fix.** Set the manifest to `1.16` and model-policy to `~1.16 GB`.

---

#### DOC-4 — Dangling `§11.1` citation in a test comment
- **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/tests/integration/benchmark.test.ts:104` cites "GPU record §8/§11.1"; the
  GPU record is "§1–§8" and there is no §11.1 in `architecture.md`. (The §8 half resolves.)
- **Recommended fix.** Drop `/§11.1`.

---

#### TEST-4 — Skills-installer error constants (`encryptedZip`, `invalidPath`/NUL, `pathTooLong`) have no test
- **Severity:** Low · **Confidence:** High
- **Location:** `tests/integration/skills-installer.test.ts` vs guards at `installer.ts:167-193,266,267`.
- **Description.** The installer is the best-tested security surface (the S-1 zip-bomb positive control is
  exemplary), but three coded guards are unasserted: the ZIP64/encrypted-GP-flag rejection, the SEC-N1
  NUL-byte `invalidPath` content-leak defense, and `maxPathLen`. The folder-source symlink test silently
  early-returns without symlink privilege (so `assertNoSymlinks` is effectively untested on the dev/CI
  box). The "never routes through tar" test is a brittle source-grep (passes regardless of runtime).
- **Recommended fix.** Add fixtures for the three error constants; make the no-tar assertion behavioral
  or label it documentation-only.

---

#### TEST-5 — Vision success-path / OCR no-leak tests bypass the real runtime
- **Severity:** Low · **Confidence:** High
- **Location:** `tests/integration/vision-security.test.ts:268-345`.
- **Description.** The loopback-only and runtime-failure no-leak tests use the real `VisionRuntime`, but
  the success-path and OCR-isolation no-leak tests replace `createRuntime` with a hand-written fake
  `analyze`, bypassing the real SSE-parsing/HTTP internals. So the "no image/prompt bytes in any log"
  guarantee for the **streaming-success path of the real runtime** isn't exercised.
- **Recommended fix.** Route at least one success-path no-leak test through the real `VisionRuntime` with
  a recording fetch (the loopback test already shows the pattern).

---

#### SEC-2 — `previewSkillPackage` stages untrusted skill content to the shared OS temp dir
- **Severity:** Low · **Confidence:** Medium
- **Location:** `skills/installer.ts:549` — `mkdtempSync(join(tmpdir(), 'hilbertraum-skill-preview-'))`.
- **Description.** Content is path-/size-validated first and cleaned in `finally`, so this is not an
  escape; the minor concern is attacker-controlled bytes briefly landing in world-readable `%TEMP%`
  (vs. `importSkill`, which stages under `user-skills/`). Skill packages aren't secret, so impact is low.
- **Recommended fix.** Stage preview under a `mkdtemp` inside `userSkillsDir` for trust-zone consistency.

---

#### SEC-3 — Dialog-opener IPC (`pickSkillPackage`/`pickDocuments`/`imageChooseImage`) not behind `requireUnlocked()`
- **Severity:** Low (informational) · **Confidence:** High
- **Location:** `registerSkillsIpc.ts:152`, `registerDocsIpc.ts:233`, `registerImagesIpc.ts:104`.
- **Description.** These open an OS dialog and mint a capability token while the vault is locked; they
  touch no DB and the **consuming** handlers (`importSkill`/`importDocuments`/`imageReadBytes`) are all
  gated, so the token is useless until unlock. A consistency gap, not an exploit.
- **Recommended fix.** Optionally add `requireUnlocked()` so the unlock gate is the single choke point.

---

### INFO / by-design (recorded so the next audit doesn't re-investigate)

- **TEST-6 — No automated answer-quality floor.** The `eval/skill-triggers` harness prints precision as a
  *measurement*, not a gate (the S13b precision-bar assertion is owner-gated on D1), and the real-model
  quality benchmarks are env-gated out of CI (correctly — they need weights). Net: retrieval/answer/
  trigger-accuracy regressions are caught only by the manual smoke matrix. Acceptable, but worth stating
  explicitly in the testing docs. Land the S13b bar when D1 is set.
- **CSV single-data-row / DOCX paragraph-split / `embedChunks` single-batch / `corpusNeedsReindex`
  double-scan / rerank-before-dedup cost** — low-severity edge/robustness notes from the RAG review; all
  acceptable as-is, listed in §5 for completeness.
- **REL-3 (OCR reply waiter channel-only), PERF-5 Part B (list windowing), E5 prefix migration** — already
  owner-dispositioned residuals from the 2026-06-28 audit; unchanged.

---

## 3. Documentation audit

The docs are accurate to an unusual degree — the 2026-06-28 DOC-N1…N7 fixes all landed, the §-anchor
citation system mostly resolves, env-vars/model-tables/numeric-constants were spot-checked (~30 values)
and match code. The drifts found:

| ID | Doc | Problem | Fix |
|----|-----|---------|-----|
| DOC-1 | `collections.ts:21` header | Claims a *shipped* feature (C2 delete-with-documents) is "left out of v1" and cites the wrong § (`rag-design §13.7`). **Misleads agents into thinking it's unimplemented.** | Drop the clause; repoint to `architecture.md` §1 C2. |
| DOC-2 | `architecture.md:1622` | "60 s health timeout" but code is 180 s (`DEFAULT_HEALTH_TIMEOUT_MS`). | "180 s (3 min)". |
| DOC-3 | `bge-reranker-v2-m3.yaml:8` + `model-policy.md:33` | `1.08` is GiB mislabeled GB; decimal is `1.16`. | `1.16 GB`. |
| DOC-4 | `benchmark.test.ts:104` | Dangling `§11.1` (GPU record is §1–§8). | Drop `/§11.1`. |
| SEC-1 (doc half) | `security-model.md` | Offline password-guessing / no-unlock-rate-limit residual is undocumented. | Add an accepted-residual note. |
| BL-1 (doc half) | `architecture.md` §8 + known-limitations | Leading-minus money support undocumented (after the fix). | Add the as-built note. |

Verified-clean (no action): all README/CONTRIBUTING/CLAUDE commands vs `package.json`; ~20
`HILBERTRAUM_*` env vars and their defaults/clamps; all 9 chat + 4 supporting model rows
(size/Min-RAM/license) and the `-WithAssets` default set vs both prepare-drive scripts; chunk/top-k/
RRF/reranker/context/benchmark constants; service-boundary map; ~16 other §-anchor citations
(`tool-runs.ts §7/§23`, `money.ts §24`, `manager.ts §22`/§14.4, `rag/index.ts §19/§20`, GPU record §5.x,
`collections.ts §13`, …) — all resolve.

---

## 4. Testing audit

**Strengths (verified, genuinely strong).** Financial parsing, crypto/vault, data-atomicity, and
RAG/reranker suites are well above typical: adversarial whole-string fixtures through real entry points,
real `node:crypto` (not mocked), crash-recovery of password-change by cutting the journal at each step,
a real feature-hashing MockEmbedder so ranking tests aren't tautological, EXPLAIN-QUERY-PLAN index
assertions, and a genuinely valuable full-suite guard that catches vitest under-collecting files. The
"teeth-check" discipline is real, not decorative — every teeth claim spot-checked maps to a true
neuter→fail relationship. Skips (39) are all env-gated manual/real-binary smokes, **zero** `.skip` rot.

**Weaknesses / gaps (actionable):**
- **TEST-1 (High):** the suite is intermittently red (iteration-capped poll). Fix first.
- **Enforcement-vs-correctness gaps:** TEST-2 (binary-verifier spawn seam unwired-undetectable),
  TEST-3 (embed-failure not proven at `generateGroundedAnswer`/UI), TEST-4 (installer error constants),
  TEST-5 (vision success path bypasses real runtime). These are the highest-value additions — a correct
  control that nothing proves remains *wired* is a regression waiting to happen.
- **Brittle assertions to tidy:** a few label-presence renderer tests and the source-grep "no tar" /
  "no extractWithTar" tests (pass regardless of runtime). Low priority.
- **No automated answer-quality floor (TEST-6, by design):** document it; land the S13b precision bar
  when the owner sets D1.

**Avoid over-mocking guidance:** the gaps above are precisely where mocks replaced the real seam
(`createRuntime` fake in vision, no real spawn in binary-verifier). Prefer the existing real-harness
patterns (`FakeChild`, recording `fetch`, real `VisionRuntime`) when closing them.

---

## 5. Performance audit

- **PERF-1 (Medium, the real ceiling):** resident-vector cache full-rebuild on every embeddings write —
  make it incremental (see finding). This is the one with user-visible impact at scale.
- **Renderer:** prior memoization (FE-1 AnswerThread, PERF-5 DocRow) is solid; list windowing
  (PERF-5 Part B / FE-5) remains deliberately deferred (variable-height rows + scroll/find/a11y are
  behavior-sensitive, no vlib in deps). Not re-opened.
- **REL-4 (Low):** per-request timeout-timer accrual under heavy ingestion — clear in `finally`.
- **Low/by-design notes:** `embedChunks` materializes all per-file chunk texts in one `embed()` call
  (bounded only by the 1000-chunk cap — latent coupling if the cap rises); `corpusNeedsReindex` runs two
  full-scan `EXISTS` subqueries on the empty-retrieval path (only when retrieval already failed);
  rerank-before-dedup can spend the cross-encoder on chunks that collapse by page (correct by design, a
  cost tradeoff on page-heavy PDFs). None require action now.
- **Validation:** add the EXPLAIN/bench/decode-count assertions noted per finding; measure
  resident-cache rebuild time before/after the incremental change on a synthetic 100k-vector DB.

---

## 6. Phased remediation plan

Each phase is sized for a fresh Claude Code session, ends with the per-phase ritual (tests green, app
builds, docs + `BUILD_STATE.md` updated, commit referencing the phase), and is independent except where
noted. Suggested branch: `full-audit-2026-06-29-fixes`.

### Phase 0 — Stop the bleeding: de-flake the suite (TEST-1)
- **Goal.** Restore a reliably-green suite so every later phase can trust `npm test`.
- **Scope / files.** `tests/integration/dictation-ipc.test.ts:223`.
- **Steps.** Replace the iteration-capped poll with a wall-clock deadline (`Date.now() - start < 5000`),
  matching the rest of the integration suite. Re-run `npm test` 3× to confirm stability.
- **Tests.** The existing REL-3 concurrency test, now stable.
- **Docs.** Refresh the `BUILD_STATE.md` test-count headline after a clean run.
- **Acceptance.** 3 consecutive green full-suite runs; no other test touched.
- **Risk/rollback.** Negligible (test-only).

### Phase 1 — Financial correctness (BL-1, BL-2, BL-3)
- **Goal.** Eliminate the wrong-number and silent-suppression bugs on bank-statement extraction.
- **Scope / files.** `skills/tools/money.ts` (`MONEY_RE`, `wordIncludes`),
  `skills/tools/bank-statement.ts` (currency precedence, categorizer), `skills/categorizer.ts`;
  tests under `tests/unit/skills-bank-statement-tool.test.ts` (+ invoice).
- **Steps.**
  1. **BL-1:** guard the trailing `-?` in `MONEY_RE` so it can't consume a following figure's leading
     minus; re-run all existing money/bank/invoice fixtures (must stay green — de-AT trailing minus,
     grouping, ReDoS-linear).
  2. **BL-2:** change `detectCurrency(line) ?? statementCurrency` → `statementCurrency ?? detectCurrency(line)`
     (or restrict per-row detection to the figure region).
  3. **BL-3:** relax `wordIncludes` for the German keyword list to allow compound (one-sided) matches
     while keeping strict boundaries for short English tokens.
- **Tests.** New fixtures: negative running balance (sign + reconciliation), credit-into-overdraft;
  EUR statement with `USD`/`$` in a description (totals still computed); `Kontoführungsgebühr`→Fees,
  `Gehaltszahlung`→Income, `SEPA-Überweisung`→Transfer. Teeth-check each (revert → fail).
- **Docs.** `architecture.md` "Skills" §8 money notes; `docs/known-limitations.md` if any residual.
- **Acceptance.** New fixtures pass; the full pre-existing financial suite stays green; manual spot-check
  on a sample negative-balance statement (`sample-data/`).
- **Risk/rollback.** Regex change is blast-radius-bounded by the extensive existing fixtures — run them
  first as a characterization baseline before editing. BL-1 is the must-ship item.

### Phase 2 — Runtime reliability (REL-1, REL-2, REL-3; optionally REL-5)
- **Goal.** No hung shutdown, no GPU mis-disable on a port race, responsive Stop under load.
- **Scope / files.** `runtime/sidecar.ts` (port retry + `onGpuFailure` narrowing),
  `transcriber/cli.ts` (SIGKILL escalation + bounded await), `ipc/chat-stream.ts` +
  `model-slot-arbiter.ts` (thread the abort signal into the slot wait); optionally a `withTransaction`
  helper for REL-5.
- **Steps.** Per findings: retry-once-on-bind-exit + don't persist `gpuAutoDisabled` on a bind error;
  mirror `LlamaServer.stop()` SIGKILL escalation in whisper; pass `controller.signal` into
  `acquireForChat` and reject on abort.
- **Tests.** Bind-exit retry (no `gpuAutoDisabled`); SIGTERM-ignoring fake child → `stop()` resolves via
  SIGKILL within grace; abort-during-slot-park unwinds promptly. Teeth-check each.
- **Docs.** `architecture.md` GPU/runtime record (and fix DOC-2's 180 s while here).
- **Acceptance.** New tests green; manual: quit while a (simulated) wedged whisper runs returns promptly.
- **Risk/rollback.** Process-lifecycle changes — keep each fix in its own commit; REL-5 is optional/
  defense-in-depth and can be split out if it grows.

### Phase 3 — Test enforcement gaps (TEST-2, TEST-3, TEST-4, TEST-5)
- **Goal.** Make the security/reliability controls *regression-proof*, not just correct-in-isolation.
- **Scope / files.** `tests/integration/{binary-verify-spawn,rag,skills-installer,vision-security}.test.ts`
  (new/extended); no source change expected unless a seam needs a test hook.
- **Steps.** Add: spawn-refused-on-hash-mismatch per seam (FakeChild harness); `generateGroundedAnswer`
  rejects on failing embedder; fixtures for `encryptedZip`/`invalidPath`-NUL/`pathTooLong`; one
  real-`VisionRuntime` success-path no-leak test with a recording fetch.
- **Tests.** The above; each teeth-checked by neutering the control.
- **Docs.** Testing section of `architecture.md` / `docs/` testing notes; document TEST-6 (manual
  quality gate).
- **Acceptance.** New tests green and fail when their control is neutered.
- **Risk/rollback.** Test-only; low risk. Independent of Phases 1–2 (can run in parallel by another session).

### Phase 4 — Renderer lifecycle + determinism/robustness low-hangers (FE-1, RAG-1, RAG-2, REL-4)
- **Goal.** Close the FE-4-class unmount gap and the cheap determinism/robustness items.
- **Scope / files.** `renderer/screens/ChatScreen.tsx` (mountedRef + flush-timer cleanup);
  `embeddings/index.ts` + `rag/hybrid.ts` (id tiebreaks); `rag/index.ts` (surrogate-safe snippet);
  `runtime/sidecar.ts` (`combineSignals` clear-in-finally).
- **Steps / tests.** Per findings; add a ChatScreen unmount-mid-import test, an RRF tie-break
  determinism test, a surrogate-pair snippet test, and assert no lingering timer after an embed batch.
- **Docs.** Renderer record note; rag-design tie-break note.
- **Acceptance.** New tests green; full suite green.
- **Risk/rollback.** Low; renderer change is guard-only (no main-side stream teardown).

### Phase 5 — Resident-cache incremental maintenance (PERF-1)
- **Goal.** Remove the per-write full cache rebuild (the 100k-scale main-thread stall).
- **Scope / files.** `embeddings/resident-cache.ts`, invalidation hooks in `ingestion/index.ts`.
- **Steps.** On insert, decode only new rows into the existing map; on delete, drop the ids; keep the
  `(count, maxRowid)` signature as a correctness backstop / full-rebuild fallback.
- **Tests.** After insert K, cache = old+new with decode-count == K (spy); after delete, ids gone; a
  bench note for rebuild-time before/after on a synthetic large DB.
- **Docs.** `docs/rag-design.md` / `architecture.md` cache design record (supersede the D15/P4 note for
  the per-write path).
- **Acceptance.** Tests green; measured rebuild cost no longer scales with corpus size on a pure-add.
- **Risk/rollback.** Correctness-sensitive (cache coherence) — the signature backstop makes a wrong
  incremental update self-heal on the next query; keep that path.

### Phase 6 — Documentation reconciliation (DOC-1…DOC-4, SEC-1 doc half) + audit close-out
- **Goal.** Fix the doc drifts and fold this audit into the topic-doc §§ + a ledger, per the doc-lifecycle rule.
- **Scope / files.** `collections.ts` header (DOC-1), `architecture.md:1622` (DOC-2),
  `bge-reranker-v2-m3.yaml` + `model-policy.md` (DOC-3), `benchmark.test.ts:104` (DOC-4),
  `security-model.md` (SEC-1 residual); then a new `architecture.md` "§26 Full audit (2026-06-29)"
  ledger mirroring §25, and `git rm` this report.
- **Steps / acceptance.** Apply the doc edits; verify the §-anchor citations resolve; add the per-finding
  ledger; retire the report (recoverable in git history per the lifecycle rule).
- **Risk/rollback.** Docs/comments only.

---

## 7. Recommended execution order

1. **Phase 0 (de-flake) — first, immediately.** Everything downstream relies on a trustworthy
   `npm test`. Tiny, test-only, unblocks confidence.
2. **Phase 1 (financial correctness) — next, highest user harm.** BL-1 produces *wrong money*; ship it
   before any release. BL-2/BL-3 ride along (same files, same fixtures).
3. **Phase 2 (runtime reliability)** and **Phase 3 (test enforcement gaps)** — can proceed **in parallel**
   in separate sessions (disjoint files; Phase 3 is test-only). Do Phase 2 before a release because of the
   hang-on-quit (REL-2).
4. **Phase 4 (renderer + low-hangers)** — independent; any time after Phase 0.
5. **Phase 5 (resident-cache)** — independent; schedule when scale matters or before a large-corpus push.
6. **Phase 6 (docs + close-out)** — **last**, so it folds the as-built records from Phases 1–5.

**Dependencies.** Phase 0 → all (green baseline). Phase 6 depends on 1–5 landing (it documents their
as-built state). Phases 2/3/4/5 are mutually independent. Within Phase 1, run the existing financial
fixtures as a characterization baseline **before** touching `MONEY_RE`.

**Only two items are release-blocking:** BL-1 (wrong financial figures) and TEST-1 (red suite); REL-2
(hang on quit) is a strong should-fix. Everything else is quality/robustness and can be scheduled.

---

### Appendix — what was checked and found clean (so the next audit can skip it)
Vault crypto (AES-256-GCM streaming, fresh IV, GCM-verify-before-trust, Argon2id bounds, key-zeroing,
journaled rekey), binary-verifier verdict/cache logic, Electron BrowserWindow hardening (contextIsolation/
sandbox/CSP/nav+permission guards), preload surface, skills zip reader + tool gate, capability-token
file-read model, vision input validation + lock purge, network offline-guard, chunker windowing/overlap
math (traced with the real regex), embedding normalization/dimension guards, vector codec round-trip, FTS5
self-contained schema + triggers, RRF math + pass-through guarantee, reranker truncation/budget/index-
mapping, over-cap `fully_chunked` fail-closed invariant, tree-build termination + per-node txn, GPU
`forceRestart` idempotency, `LlamaServer.stop()` SIGKILL escalation, SSE reader cancellation, migration
idempotency/backfills, download verify-before-rename + resume + body cap, i18n en/de parity
(compile-enforced, 1128 keys), module-store poll self-stop, timer/listener cleanup across screens, CI
workflow (offline matrix, npm-ci-pinned, least-privilege token, aggregate gate), full-suite guard, and the
"teeth-check" discipline. Financial helpers verified correct: `parseAmount` locale/paren/Swiss-apostrophe,
integer-cent reconciliation + float-drift fix, invoice totals validation, `summarizeCashflow`
self-consistency, redaction de-AT formats, date inference, doctask compare swap-invariance.
