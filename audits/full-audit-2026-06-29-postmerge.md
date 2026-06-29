# Full audit — HilbertRaum (2026-06-29, post-merge fresh pass)

> Working-paper audit report. Per the CLAUDE.md doc-lifecycle rule, once findings are remediated
> this file is condensed into the relevant topic docs (architecture.md §-ledger) and `git rm`'d —
> the original stays in git history.

**Auditors:** senior engineering audit team (6 parallel personas: security/data-handling,
backend-reliability/concurrency, RAG/embeddings/retrieval, skills/financial, frontend/renderer,
testing+documentation). Read-only; **no code modified**. Every release-relevant finding was
re-verified by direct code inspection by the orchestrator.

**Baseline:** branch `master` at `f50eeec` (the `full-audit-2026-06-29-fixes` merge). Suite
independently re-run **green: 2463 passed / 39 skipped (2502 collected), 193 files, ~56 s, exit 0.**
typecheck + `npm run build` green.

---

## 1. Executive summary

### Overall health: **Strong.** Ship-quality with a small, well-bounded fix list.

This is a mature, unusually well-audited codebase (six prior audits in three weeks, the last merged
at the start of this pass). The architectural fundamentals are sound and the prior remediations are
real: I re-verified the recently-shipped fixes (BL-1/2/3 financial, REL-1/2/3/4 runtime, PERF-1
incremental cache, RAG-1/2 determinism, FE-1 unmount guard, TEST-2/3 spawn-verify) and **all are
correct with genuine teeth** — not paper fixes. Electron hardening, crypto/vault, the skills
trust/installer machinery, and the RAG grounding/honesty contract are all solid. Many plausible
leads turned out to be false positives (documented per-area so a future pass doesn't re-chase them).

The fresh pass nonetheless found **one High-severity confirmed bug** and a tight cluster of
Medium/Low issues. The pattern is informative: the prior audit hardened the **bank-statement**
parser (BL-1/2/3) and the **chat-runtime** lifecycle (REL-1/2/3/4), but the fixes did **not
propagate to the sibling code paths** — the **invoice** parser never received the BL-2 currency fix
and has no geometry backstop; the **embedder/reranker** sidecars never received the REL-1
bind-race classifier in their start-latch; and the **regenerate** chat path commits a destructive
delete before the REL-3-protected slot is claimed. Most new findings are "the fix exists next door
but wasn't applied here."

### Highest-priority risks

| # | Finding | Sev | Conf | Why it matters |
|---|---------|-----|------|----------------|
| **F1** ✅ | Unmatched amount column → running **balance read as the transaction amount** | **High** | High | Confidently-wrong money — the app's cardinal harm. Reachable on whole-euro / single-decimal / pasted-CSV rows; **worst on the invoice path** (no geometry backstop). **REMEDIATED (Phase 1).** |
| **F2** ✅ | `regenerate` **deletes the prior assistant reply (committed) before** the stream slot is claimed | Medium | High | A non-abort failure (context-exceeded HTTP 400, slot/sidecar fault) destroys the previous answer with nothing in its place. **REMEDIATED (Phase 2).** |
| **F3** | Invoice line-item **currency detected from the whole line** (BL-2 fix never applied to invoices) | Medium | High | Wrong per-line currency + mixed-currency totals reconcile against a meaningless cross-currency sum (no single-currency guard). |
| **F4** ✅ | Embedder **`startFailed` latch armed for a transient bind-race** | Medium | High | A double-unlucky startup port race **silently disables all document indexing** for the session until lock/unlock. **REMEDIATED (Phase 2).** |
| **F5** ✅ | Invoice extraction **re-inserts a fresh invoice + line items on every analysis question** | Medium | High | Unbounded growth of the content-class tables; no reuse/replace/staleness (bank path has all three). **REMEDIATED (Phase 3).** |

### Biggest opportunities for improvement

1. **Propagate the bank-path hardening to the invoice path** (F1, F3, and the column-fusion /
   qty-split residuals). The invoice parser is the most parse-fragile money path in the app and is
   exactly where the new financial bugs concentrate.
2. **Generalize the lifecycle controls the prior audit applied point-wise.** The bind-race
   classifier (`isBindRaceError`) should gate every sidecar start-latch (F4 embedder, F7 reranker),
   not just chat; the FE-4 `mountedRef` discipline should cover the last hold-out screens (F20–F22).
3. **Close the test-enforcement seams** that prove security/reliability controls stay *wired*
   (lock-purge on lock, rag:ask lock-gate, the SIGTERM-ignore escalation at the unit tier) — the
   prior audit started this (TEST-2/3); a few high-value seams remain.
4. **A documentation reconciliation pass** — three Medium doc/code contradictions surfaced (one of
   them in a record written *during* the prior audit, already stale).

### What was checked and found clean (so it is not re-investigated)

Crypto core (Argon2id/AES-GCM, KDF bounds, IV freshness, tag verify, key zeroization); vault
streaming crypto + atomic rename + journaled rekey + crash-sweep; skills installer
(enumerate-before-inflate, path/symlink/NUL/depth re-validation, in+out inflate bounds,
prototype-pollution-free manifest validator); binary verify wired at all three spawn seams; Electron
hardening (contextIsolation/sandbox/nodeIntegration:false, preload allowlist, prod CSP, navigation
guards); offline guard (end-anchored loopback, octal/hex/decimal SSRF forms normalized — **only** the
mapped-IPv6 form leaks, F15); `LlamaServer`/GPU-probe/transcriber lifecycle (single-flight start,
bind-retry, SIGTERM→SIGKILL escalation, unref'd timers); slot arbiter REL-3 abort-aware handoff;
`combineSignals` REL-4 timer cleanup; **every `db.exec('BEGIN')` site is synchronous between
BEGIN/COMMIT** (REL-5 deferral justified — verified, see §4); vector codec round-trip; PERF-1
incremental cache byte-equivalence; RAG grounding/`NO_DOCUMENT_CONTEXT`/`REINDEX_NEEDED` honesty;
FTS trigger sync; renderer markdown XSS surface (react-markdown, no `rehype-raw`, link allowlist);
`data:`-only image preview (no `blob:`/object-URL leak); `doc-lock` FIFO mutex. **~70 documented
numeric constants matched code exactly** (the prior DOC-2 180 s + DOC-3 1.16 GB fixes landed).

---

## 2. Findings

Severity = Critical / High / Medium / Low. Confidence = High / Medium / Low. All locations verified.

### F1 — Unmatched amount column: the running balance is silently read as the transaction amount
> **✅ REMEDIATED — Phase 1 (branch `audit-postmerge-phase1-money`).** Fixed via a **statement-context-aware**
> drop (DIVERGED from the literal recommendation below): `bank-statement.ts parseLine` flags `ambiguousAmount`
> (one money token + a bare-number-trailing description); `extractTransactionRows` drops it **only when the
> statement has a balance column** — the unconditional drop regressed the HVB "Umsätze" no-balance numeric-
> payee format (`REWE … 1234 -19,15`, `pdf-bank-layout.test.ts`). The invoice mirror drops a RIGHT-side
> uncaptured column (line total = LAST figure). Tests in `skills-bank-statement-tool.test.ts` /
> `skills-invoice-tool.test.ts`. Disposition: architecture.md §27 + §8.
- **Category:** Financial-correctness
- **Severity:** **High** · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/tools/bank-statement.ts:140-141` (`parseLine`); same shape `tools/invoice.ts:283` (`parseLineItem`, takes `amounts[length-1]`)
- **Description:** `parseLine` picks the amount column by *count* of `MONEY_RE` matches: `hasBalance =
  matches.length >= 2; amount = parseAmount(matches[hasBalance ? length-2 : 0])`. This is correct
  **only when the amount figure actually matched `MONEY_RE`**. `MONEY_RE` (money.ts:81-82) requires
  a 2-digit decimal tail or a grouped-thousands form — it **rejects a bare ungrouped integer**
  (`50`, `500`, `1500`) and a **single-decimal figure** (`12,5`, `0,5`). When the amount is such a
  figure but the **balance** column is a normal 2-dp figure, the row collapses to exactly one match,
  `hasBalance` becomes false, and the code takes `matches[0]` — *the balance* — as the amount.
- **Evidence (traced through the real column logic):**
  ```
  "Sparen 50 1.234,56"   → MONEY_RE matches ["1.234,56"]  (the "50" is rejected)
                         → amount = 1234.56  (WRONG: should be 50; balanceAfter lost)
  "Zinsen 12,5 1.000,00" → MONEY_RE matches ["1.000,00"]  ("12,5" rejected)
                         → amount = 1000     (WRONG: should be 12.5)
  ```
  Code: `bank-statement.ts:140` `const hasBalance = matches.length >= 2` /
  `:141 const amount = parseAmount(matches[hasBalance ? matches.length - 2 : 0][0])`. The
  `reconcileBalances` safety net cannot catch it — the row records no `balanceAfter` (so it is
  `unknown`) — and `summarizeCashflow` then sums the balance magnitude into the wrong inflow/outflow.
- **Consequences:** A confidently-wrong amount — off by the *running-balance magnitude*, often
  orders of magnitude larger — enters the persisted rows and the cashflow total, undetectable by
  reconciliation. This is the exact "confidently wrong about money" harm the app's honesty posture
  (architecture §8 / §22-D1) exists to prevent. **Trigger:** a non-2-dp amount column — realistic on
  pasted/CSV statements and whole-euro/interest rows; the **invoice path is more exposed** (a
  whole-dollar line `Consulting 500 ... 500` behaves identically and the invoice path has **no
  geometry backstop**, F10). Clean 2-dp PDF statements (helped by the geometry pass) are largely safe.
- **Recommended fix:** Don't infer the amount column from match count alone. Preferred (honesty
  posture): when exactly one money token matches but **unmatched digit-runs remain to its left
  inside the figure region**, treat the row as ambiguous and **drop it** rather than promote the
  balance to amount. Alternative: widen `MONEY_RE` to capture a bare integer **only inside the
  figure region** (after the description boundary) so whole-number amounts match and the
  second-to-last-position logic holds. Apply to both bank and invoice parsers.
- **Testing needed:** Whole-string `parseLine`/`extractTransactionRows` tests: whole-euro amount +
  2-dp balance; 1-decimal amount + balance; a genuine single-figure no-balance row (must still
  work); an invoice `parseLineItem` whole-dollar line. Teeth: assert the balance magnitude never
  appears as `amount`.
- **Doc updates:** Replace the known-limitations "with one figure that figure is the amount" bullet
  with the corrected rule + chosen behavior; record in architecture.md §8 + a new §-ledger entry.

### F2 — `regenerate` deletes the prior assistant reply before the stream slot is claimed → data loss on a non-abort failure
> **✅ REMEDIATED — Phase 2 (branch `audit-postmerge-phase2-runtime-reliability`).** The IPC layer now does
> only the read-only `hasRegenerableAssistantReply` precondition (the unchanged "nothing to regenerate" bail)
> BEFORE the stream; the destructive delete runs INSIDE `withChatStream`'s `runFn` via `withRegenerateGuard`
> (`ipc/chat-stream.ts`) — slot held + controller registered — and the snapshot is re-inserted byte-faithfully
> (`restoreMessage`) on a non-abort failure. A user Stop keeps the delete. Applied symmetrically to BOTH the
> chat and RAG channels. Tests: `chat-ipc.test.ts`, `rag-regenerate-ipc.test.ts`, `chat.test.ts` (round-trip).
> Disposition: architecture.md §28 + "Chat & streaming".
- **Category:** Data-integrity / Concurrency
- **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/ipc/registerChatIpc.ts:239` (the committed DELETE) vs `:269`
  (`withChatStream` entry); symmetric on the RAG path in `registerRagIpc.ts`
- **Description:** On `regenerate`, `deleteLastAssistantMessage(ctx.db, conversationId)` **commits**
  the DELETE of the previous assistant reply *before* `withChatStream` registers the in-flight
  controller / acquires the slot / begins generation. If anything between the delete and the first
  persisted token throws a **non-abort** error — `acquireSlot` rejecting, a sidecar that died
  mid-session, or (notably reachable) an `exceed_context_size_error` HTTP 400 because regenerate
  replays the full history near the window — `generateAssistantMessage` re-throws (`chat.ts:1075`
  `if (!isAbortError(err, opts.signal)) throw err`), the IPC rejects, and the prior answer is
  already gone with nothing in its place.
- **Evidence:** `registerChatIpc.ts:239` `if (!deleteLastAssistantMessage(ctx.db, conversationId))`
  (node:sqlite is synchronous — the delete is durable immediately) executes before the `return
  withChatStream(...)` at `:269`.
- **Consequences:** A regenerate that fails on a real (non-Stop) error silently destroys the user's
  previous answer. The context-exceeded variant is most reachable: a long conversation whose
  regenerate prompt 400s leaves the turn answer-less and irrecoverable (the 400 even maps to a
  benign "too large" toast, so the user sees a friendly message and an emptied turn). The normal
  path's `appendMessage(role:'user')` has the same ordering but is *additive* → harmless; only the
  regenerate delete is destructive.
- **Recommended fix:** Defer the destructive delete until **inside** `withChatStream`'s `runFn`
  (after the controller is registered and the slot held), or snapshot the deleted row and re-insert
  it on a non-abort failure. Apply symmetrically to the RAG channel.
- **Testing needed:** Integration test: regenerate where `runtime.chatStream` throws a
  `ChatRequestError` (400) → assert the prior assistant row still exists (or is restored) and the
  conversation is not left answer-less.
- **Doc updates:** Note in architecture.md "Chat & streaming" that regenerate is delete-after-slot.

### F3 — Invoice line-item currency is detected from the WHOLE line (the BL-2 figure-region fix was never applied to the invoice path)
> **✅ REMEDIATED — Phase 1 (branch `audit-postmerge-phase1-money`).** `invoice.ts parseLineItem` detects
> currency on `rest.slice(matches[0].index)` (figure region, mirror of the bank fix); `validateInvoiceTotals`
> gained the single-currency guard (`lineItemsSumToNet: 'unknown'` for a >1 line-item currency set).
> Disposition: architecture.md §27 + §8.
- **Category:** Financial-correctness
- **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/tools/invoice.ts:268` —
  `const currency = detectCurrency(line) ?? documentCurrency`
- **Description:** BL-2 fixed the **bank** `parseLine` to detect per-row currency only in the figure
  region (`rest.slice(matches[0].index)`, bank-statement.ts:151-152). The **invoice
  `parseLineItem` still scans the entire line** including the free-text description. A line item
  whose description contains a currency word/symbol is tagged with that currency; `detectCurrency`
  scans ISO codes before symbols, so a description code beats the figure-adjacent symbol.
- **Evidence:**
  ```
  "USD adapter cable 12,50"  docCur=EUR → currency:"USD"  (WRONG: should be EUR)
  detectCurrency("€100,00 ref USD") → "USD"   (figure-adjacent € loses to a later USD token)
  ```
  No test covers a currency word in an invoice description (`skills-invoice-tool.test.ts` has none).
- **Consequences:** (1) Persisted `invoice_line_items.currency` is wrong; the CSV export emits the
  wrong per-line currency. (2) `validateInvoiceTotals` sums `lineItems.lineTotal` across the
  now-mixed currencies with **no single-currency guard** (unlike the bank gate), so
  `lineItemsSumToNet` reconciles against a meaningless cross-currency sum — passing or failing
  spuriously. Exactly the BL-2 harm class, unfixed for invoices.
- **Recommended fix:** Mirror the bank fix — `detectCurrency(rest.slice(matches[0].index)) ??
  documentCurrency`. Separately add a single-currency guard to `validateInvoiceTotals` (return
  `lineItemsSumToNet:'unknown'` when `new Set(lineItems.map(li=>li.currency)).size > 1`), mirroring
  `assessCompleteness`/`reconcileBalances`.
- **Testing needed:** Invoice line with a foreign currency word in the description (figure-region /
  `documentCurrency` wins); a genuinely figure-adjacent foreign line still detected; mixed-currency
  `validateInvoiceTotals` returns `unknown`.
- **Doc updates:** Extend the known-limitations BL-2 bullet to state the invoice path now matches the
  bank path.

### F4 — Embedder's `startFailed` latch is armed for a transient bind-race → all imports fail until lock/unlock
> **✅ REMEDIATED — Phase 2 (branch `audit-postmerge-phase2-runtime-reliability`).** `e5.ts`'s start `.catch`
> now skips arming `startFailed` when `isBindRaceError(message)` (reusing the REL-1 classifier — the retry and
> the latch agree), so a transient double-bind-race leaves the latch null and the next `embed()` re-attempts on
> a fresh port. A genuine load fault still latches (and still clears on `suspend()`). Test:
> `e5-embedder.test.ts` (double-bind-race at the real spawn/health seam). Disposition: architecture.md §28 +
> GPU record §5.5b; known-limitations (embedder latch).
- **Category:** Reliability
- **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/embeddings/e5.ts:150-153` (the `.catch` arms
  `startFailed` unconditionally); rethrown at `:108`
- **Description:** `ensureStarted`'s start chain arms `this.startFailed` for **any** rejection,
  including a port-bind race (`EADDRINUSE`). `LlamaServer.start` retries a bind race only **once**
  (REL-1, sidecar.ts); if the embedder loses the port twice during the documented near-simultaneous
  chat+embedder+reranker+vision startup, `start()` throws a bind-class error and the latch arms.
  Thereafter `ensureStarted` throws the cached error immediately (`:108 if (this.startFailed) throw
  this.startFailed`). The latch is *intended* for a non-transient fault (a bad GGUF) but the code
  does not discriminate — and the codebase already has the classifier (`isBindRaceError`,
  sidecar.ts) used exactly this way for the GPU ladder.
- **Evidence:** `e5.ts:150-153` `.catch((err) => { this.startFailed = err instanceof Error ? err :
  new Error(String(err)); throw this.startFailed })`. Impact path: `finalizeDocument` →
  `embedChunks` → `ensureStarted` throws → document lands `status='failed'`. The embedder has **no
  graceful degradation**, so every subsequent import fails until `suspend()` clears the latch
  (`e5.ts:268`), which only happens on workspace lock/unlock.
- **Consequences:** A doubly-unlucky startup port race silently disables all document indexing for
  the session; the only recovery is the non-obvious lock/unlock. Low probability, durable and silent
  when hit.
- **Recommended fix:** In the `.catch`, do not arm `startFailed` when `isBindRaceError(err.message)`
  — leave it null so the next `embed()` re-attempts a fresh start on a new port (mirroring the GPU
  ladder's transient treatment).
- **Testing needed:** Inject a spawn that yields a bind-race exit twice → assert `startFailed` stays
  null and a subsequent `embed()` retries (doesn't throw the cached error).
- **Doc updates:** `known-limitations.md` embedder note — the transient-vs-permanent latch
  distinction.

### F5 — Invoice extraction re-inserts a fresh invoice + line items on every analysis question (no reuse / replace / staleness)
> **✅ REMEDIATED — Phase 3 (branch `audit-postmerge-phase3-invoice-lifecycle`).** The invoice path now mirrors
> the bank reuse gate: `invoices` gained an additive nullable `extractor_version` column (`db.ts`,
> `ensureColumn` — old workspaces open cleanly), `runInvoiceExtraction` stamps `INVOICE_EXTRACTOR_VERSION`
> (`tools/invoice.ts`) and accepts `replaceExisting`, and `analysis/invoice.ts` REUSES `latestInvoiceId` unless
> `isInvoiceStale` (NULL/legacy or `<` current), else re-extracts with `replaceExisting: true` — the shared
> `deleteInvoicesForDocument` runs in FK order INSIDE the persist `BEGIN/COMMIT` before the INSERT. N questions
> now persist exactly one invoice + one line-item set. Disposition: architecture.md §29 + §8.
- **Category:** Data-integrity
- **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/skills/analysis/invoice.ts:276` (calls
  `runInvoiceExtraction` unconditionally) + `invoice-run.ts:154` (always `INSERT`s a new `invoices`
  row with a fresh UUID; no `replaceExisting`, no `extractor_version`)
- **Description:** The bank path reuses a fresh statement and uses `replaceExisting` +
  `extractor_version`/`isBankStatementStale` to avoid duplicates and stale figures. The invoice path
  has **none** of this: `runInvoiceExtraction` always inserts a brand-new `invoices` row and never
  deletes priors, and the invoice analysis handler calls it on **every** analysis-shaped question.
  There is no `extractor_version` column on `invoices` at all. `grep` confirms no
  `replaceExisting`/`isInvoiceStale`/`extractor_version` anywhere in the invoice path.
- **Evidence:** `invoice-run.ts:154 const invoiceId = randomUUID()` then `INSERT INTO invoices ...`
  with no preceding delete; `analysis/invoice.ts:276 const extraction = await
  runInvoiceExtraction(...)` runs whenever `applies()` is true.
- **Consequences:** Asking N questions about one invoice persists N invoices + N×lineItems sets —
  unbounded growth in the content-class tables for a deterministic re-extraction producing identical
  rows. `purgeSkillDataForDocument` cleans them on document delete (no FK/orphan hazard), so this is
  silent table bloat + wasted work, not corruption.
- **Recommended fix:** Reuse the latest invoice when present (mirror the bank reuse + an
  `extractor_version`/staleness check — the consistent long-term shape), or pass `replaceExisting`
  to `runInvoiceExtraction` so a re-extract swaps in place.
- **Testing needed:** Run the invoice analysis handler twice over one document; assert exactly one
  `invoices` row (and one line-item set) survives.
- **Doc updates:** architecture.md §8 — invoice reuse/replace parity with bank.

### F6 — Space-separated columns can fuse into one figure on the invoice / plain-text path
> **✅ REMEDIATED (invoice path) — Phase 1 (branch `audit-postmerge-phase1-money`).** `invoice.ts`
> `isFusedSpaceGroup` drops a row whose matched token has an interior space and NO 2-dp decimal tail
> (`Widget 10 100` → 10100); `1 234 567,89` is kept; `15 799,00` (space group WITH a decimal) stays the
> accepted DECISION-2 trade-off, same as the bank plain-text path. Disposition: architecture.md §27 + §8.
- **Category:** Financial-correctness
- **Severity:** Medium · **Confidence:** High
- **Location:** `tools/money.ts:82` (the space-grouped alternative `\d{1,3}(?: \d{3})+`), exercised
  via `invoice.ts parseLineItem` and the bank plain-text fallback
- **Description:** The space-grouped thousands alternative reads `<1-3 digits> <3 digits>` as one
  figure. When two genuinely separate columns are space-separated and the right column is exactly 3
  digits, they fuse: `"Widget 10 100"` → `MONEY_RE` match `"10 100"` → `10100` (qty 10 + amount 100
  fused, ~100× too large). The bank path is mitigated by the geometry column model; the **invoice
  path is not** (F10). Partially documented (known-limitations lines 447-451 cover the
  standalone-short-group case) but not for the invoice/geometry-less path.
- **Evidence:** `MONEY_RE` alt `(?<![A-Za-z0-9])\d{1,3}(?: \d{3})+(?:[.,]\d{2})?`.
- **Consequences:** A line total / unit price read ~100× too large on space-columned plain-text
  invoices/CSVs.
- **Recommended fix:** Largely an accepted trade-off, but on the invoice path (no geometry), prefer
  dropping a row whose figure region contains an interior space-group abutting the description
  boundary, or require the space-grouped form to be flanked by currency/edge. At minimum add an
  explicit invoice-path regression test and widen the known-limitations note.
- **Testing needed:** `parseLineItem('Widget 10 100','EUR')` and a space-columned bank plain-text
  row → assert no fusion (or row dropped).
- **Doc updates:** Extend the known-limitations grouping bullet to name the invoice/no-geometry path.

### F7 — Reranker's `startFailed` latch survives `suspend()` → a transient bind-race kills reranking for the whole session
> **✅ REMEDIATED — Phase 2 (branch `audit-postmerge-phase2-runtime-reliability`).** Same `isBindRaceError`
> exclusion applied to `reranker/llama.ts`'s start `.catch`, which makes the deliberate keep-the-latch-across-
> `suspend()` policy correct again (only a genuine load fault persists; a port race is forgiven and retried).
> Tests: `reranker.test.ts` (bind-race forgiven + survives suspend; a genuine fault still persists across
> suspend). Disposition: architecture.md §28 + GPU record §5.5b; known-limitations (reranker latch).
- **Category:** Reliability
- **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/reranker/llama.ts:152-154` (arms on any error) and
  `:229-231` (`suspend()` deliberately does NOT clear `startFailed`)
- **Description:** Same unconditional-latch shape as F4 but more persistent: the reranker's
  `suspend()` intentionally leaves `startFailed` set (comment: a GGUF the server couldn't load won't
  load after unlock either). That is correct for a *bad-GGUF* fault but wrong for a *transient bind
  race*, which then disables reranking for the entire app session. User-facing impact is bounded —
  RAG `retrieve` wraps `reranker.rerank` in try/catch and falls back to fused order
  (`rag/index.ts:296`) — so it is a silent **quality** regression, not a failure.
- **Evidence:** `llama.ts` `.catch` arms `startFailed`; `suspend()` only `await this.teardown()`
  with no reset (contrast `e5.ts:268`).
- **Recommended fix:** Apply the F4 fix (don't latch a bind-race) to the reranker too; the
  `suspend()`-keeps-latch policy then becomes correct again (only genuine load faults persist).
- **Testing needed:** As F4, against the reranker.
- **Doc updates:** Update the reranker latch comment.

### F8 — Greedy trailing-number split corrupts `quantity` / description on product-coded line items
> **✅ REMEDIATED — Phase 1 (branch `audit-postmerge-phase1-money`).** `invoice.ts` `QTY_TRAIL_RE` captures
> the unit token; the split fires only with a unit token OR a corroborating unit-price column
> (`amounts.length >= 2`), so `iPhone 15 1.799,00` keeps "iPhone 15" while `Widget A 2 12,50 25,00` still
> reads qty 2. Disposition: architecture.md §27 + §8.
- **Category:** Skills-logic
- **Severity:** Low · **Confidence:** High
- **Location:** `tools/invoice.ts:145` (`QTY_TRAIL_RE`) + `parseLineItem:272-278`
- **Description:** `QTY_TRAIL_RE` splits a trailing number off the description as `quantity` even
  with **no unit word** present: `"iPhone 15"` → description `"iPhone"`, quantity `15`; `"Calendar
  2026"` → quantity `2026`. The **financial figure `lineTotal` is unaffected** (it comes from money
  tokens) — this is a metadata/display bug, hence Low.
- **Evidence:** `QTY_TRAIL_RE = /^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(?:x|×|stk…|pcs…|units?)?\s*$/i` — the
  unit suffix is optional.
- **Recommended fix:** Only split a trailing quantity when a unit token is present (or a separate
  unit-price column corroborates).
- **Testing needed:** `parseLineItem('iPhone 15','EUR')` must not produce `quantity:15`; `'Cable 3
  x'` still splits.
- **Doc updates:** known-limitations invoice line-parser bullet.

### F9 — Compaction summarizer failure is swallowed with no log → real bugs masquerade as "below threshold"
> **✅ REMEDIATED — Phase 2 (branch `audit-postmerge-phase2-runtime-reliability`).** `chat/compaction.ts`'s
> empty `catch {}` now `log.warn`s the NON-abort case (`conversationId` + the error message — no chat content)
> while keeping the L1 fallback; an `AbortError` (user Stop) still does not log. Test: `chat-compaction.test.ts`
> (non-abort throw logs warn; abort stays silent). Disposition: architecture.md §28.
- **Category:** Error-handling
- **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/chat/compaction.ts:128-134` (empty `catch {}`)
- **Description:** The `catch` around `summarizeRegion` is intentional best-effort (any failure
  falls back to L1 trim — correct), but it is **fully empty**: it logs nothing and does not
  distinguish an `AbortError` from a genuine bug (`TypeError`, malformed checkpoint). On an offline,
  no-telemetry app a repeatable summarizer bug compacts *never*, silently, on every long
  conversation — the user just gets progressively worse long-context quality with zero diagnostic
  surface. Every other chat-stack error path logs under a label.
- **Recommended fix:** Keep the fallback; log the non-abort case: `catch (err) { if (!isAbortError(
  err, opts.signal)) log.warn('Compaction summary failed; falling back to L1', {...}); return }`
  (`isAbortError` is already exported from `../chat`).
- **Testing needed:** Unit: a `summarizeRegion` that throws a non-abort error → assert `log.warn`
  fires and `ensureCompacted` still returns.

### F10 — Invoice extraction runs without geometry layout reconstruction (asymmetry with bank)
- **Category:** Correctness (design asymmetry)
- **Severity:** Low · **Confidence:** High
- **Location:** `tool-runs.ts:299-303` (`extract_invoice` omits `layout:true`) +
  `analysis/invoice.ts:266-271`; contrast `tool-runs.ts:240` (bank passes `layout:true`)
- **Description:** The bank extractor gets geometry-aware column reconstruction (D58) — the
  "stronger separator" that mitigates F1/F6 on real PDFs. The invoice extractor always reads
  byte-order text, so every plain-text column hazard hits the invoice path with no backstop. A
  deliberate scoping choice (D58 = bank-only), but it means the invoice path is the most
  parse-fragile and is precisely where F1/F3/F6 bite hardest.
- **Recommended fix:** Not necessarily to enable geometry now, but to (a) record the asymmetry
  explicitly and (b) treat the invoice parser's robustness (F1/F3/F6) as the priority since it has
  no safety net.
- **Doc updates:** architecture.md §8 / §21 — geometry is bank-only; the invoice path relies on
  reading-order text + the conservative drop posture.

### F11 — Whole-doc-tree answers persist a full leaf-provenance citation list the model never grounded on
- **Category:** Retrieval-quality (citation honesty)
- **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/rag/whole-doc-tree.ts:120` (+
  `analysis/coverage.ts:95` `documentLeafProvenance`)
- **Description:** `answerWholeDocFromTree` map-reduces over **node summaries** (no `[Sn]` markers in
  the prompt) yet persists citations for **every reachable leaf chunk** (up to ~1000). The `[Sn]`
  labels in the Sources panel point at chunks the model never saw labelled, and the model emits no
  inline `[Sn]` — diverging from the `generateGroundedAnswer` contract (citations 1:1 with labelled
  excerpts). A deliberate "all leaves are the provenance" coverage choice, but the renderer presents
  it identically to inline-cited answers.
- **Recommended fix:** Either (a) present `mode:'tree'` answers differently ("whole-document
  provenance, not inline-cited excerpts") + document the distinction, or (b) cap the persisted
  provenance list. (a) needs no behavior change.
- **Doc updates:** rag-design §14.4 — provenance citations ≠ inline-grounded `[Sn]`.

### F12 — Incremental resident-cache reconcile pays an unmeasured O(N) `SELECT chunk_id` id-scan on the first query after every write
- **Category:** Performance
- **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/embeddings/resident-cache.ts:150` (`reconcile`)
- **Description:** PERF-1 removed the per-write full *decode* (correctly — verified byte-equivalent),
  but the reconcile still runs `SELECT chunk_id FROM embeddings` (full table) + builds a
  `Set<string>` of all N ids on **every** first-query-after-write. The decode-count tests prove only
  K decodes, but the **id-scan + Set build is O(N) main-thread string marshalling and is not
  benchmarked** (`resident-cache-bench.test.ts` measures only the warm scan + cold full build). At
  the documented ~100k bound this is ~100k row marshals + a 100k-entry Set before each post-write
  query.
- **Recommended fix:** Track a per-cache `count` and skip the delete-pass when only adds occurred
  (count grew), or maintain a pending-delta set at the write sites. At minimum, add the reconcile
  leg to the benchmark and document its cost.
- **Testing needed:** Extend `resident-cache-bench.test.ts` with a reconcile leg (mark dirty + 1-row
  add at N=100k).
- **Doc updates:** architecture.md "Wave P4 / PERF-1" — note the residual O(N) id-scan.

### F13 — `minSimilarity` is applied AFTER the `topKInitial` cut → a positive floor silently loses recall
- **Category:** Retrieval-quality
- **Severity:** Low (latent; inert at the pinned default 0) · **Confidence:** High
- **Location:** `apps/desktop/src/main/services/rag/index.ts:231-233`
- **Description:** `searchText(question, topKInitial)` returns the top `topKInitial` cosine hits,
  *then* `.filter(hit => hit.score >= minSimilarity)`. The floor is applied to an already-truncated
  list. With a positive `ragMinSimilarity`, above-threshold hits ranked just outside `topKInitial`
  are never considered while below-threshold hits inside it are dropped → fewer vector candidates
  than the index could supply. Currently inert (`ragMinSimilarity` pinned at 0), but it directly
  couples to the **deferred E5 `query:`/`passage:` prefix migration**, which is explicitly intended
  to re-enable a floor — at which point this ordering becomes an active recall bug.
- **Recommended fix:** When the prefix migration enables a floor, over-fetch (search a larger K then
  floor-then-trim) or push the floor into the scan. Flag as a **precondition** of the deferred
  E5-prefix work.
- **Doc updates:** Add a one-line caveat to the E5-prefix migration TODO (rag-design §12.1 R3).

### F14 — Diagnostics log tail/export remain readable from the renderer after the vault is locked
> **✅ REMEDIATED — Phase 4 (branch `audit-postmerge-phase4-security-consistency`).** Option (a):
> `detachVaultKey()` now **zeroes the in-memory `buffer` after the final encrypted flush** (guarded on
> `mode==='encrypted'`, so the pre-FIRST-unlock diagnostics window is preserved). The lines are persisted to
> `app.log.enc` first, so the next unlock repopulates the tail — nothing is lost, only the post-lock RAM
> residue is cleared. `getLogTail`/`exportLog` stay ungated (pre-unlock diagnostics). Test: `logging.test.ts`
> (attach → write metadata lines → detach → tail/full empty → re-unlock repopulates). Disposition:
> architecture.md §30; security-model.md "Design record — encrypted log".
- **Category:** Data-handling
- **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/main/services/logging.ts` (`detachVaultKey` drops the key + sets
  `mode='buffering'` but does **not** clear the in-memory `buffer`; the `buffering`-mode read path
  returns it) consumed by `registerCoreIpc.ts` `getLogTail`/`exportLog` (intentionally not
  `requireUnlocked()`-gated — pre-auth diagnostics)
- **Description:** On "Lock now," `detachVaultKey()` zeroes the key and reverts to `buffering`, but
  the in-memory buffer still holds the just-ended session's lines (filenames, paths, model ids,
  settings keys). In `buffering` mode `readLogTail`/`readLogFull` return that buffer, so a
  still-mounted Diagnostics screen — or a compromised renderer — can read or **export** that
  metadata **while locked**. Bounded by the hard "no document/chat text in logs" rule → it is
  **metadata** exposure, not content, but it crosses the lock boundary.
- **Recommended fix:** Either (a) zero the buffer in `detachVaultKey()` after the final encrypted
  flush (next unlock repopulates from `app.log.enc`), or (b) gate the two IPCs on `isUnlocked()` for
  an encrypted workspace.
- **Testing needed:** Unit: attach key → write lines → `detachVaultKey()` → assert unlocked-session
  lines are no longer returned.
- **Doc updates:** security-model.md log-lifecycle — state the chosen post-lock behavior.

### F15 — IPv4-mapped IPv6 addresses bypass the download SSRF / private-range deny-list
> **✅ REMEDIATED — Phase 4 (branch `audit-postmerge-phase4-security-consistency`).** `isPrivateOrLoopbackHost`
> (`assets.ts`) now **denies any host containing `::ffff:`** — robust against the hex-compressed form
> `new URL()` canonicalizes to (`::ffff:7f00:1` / `::ffff:a9fe:a9fe`), which the dotted-decimal-only regex
> missed. The detection-only `offlineGuard.isLoopbackHost` was left as-is (gates no enforcement). Tests:
> `assets.test.ts` (unit on `[::ffff:127.0.0.1]` / `[::ffff:169.254.169.254]` / `[::ffff:10.0.0.1]` / the long
> `[0:0:0:0:0:ffff:127.0.0.1]` form + a redirect-hop + a public-host positive control). Disposition:
> architecture.md §30 + §25 SSRF inventory line; security-model.md §D3.
- **Category:** Security
- **Severity:** Low (Medium under the documented "a hostile model-manifest is attacker #1" model) ·
  **Confidence:** High (empirically verified)
- **Location:** `apps/desktop/src/main/services/assets.ts:422-423` (`isPrivateOrLoopbackHost`),
  enforced at `:442` / per-redirect-hop
- **Description:** The guard derives the host with `new URL(raw).hostname` and rejects
  private/loopback hosts, but its mapped-IPv6 branch only matches the **dotted-decimal** spelling
  `^::ffff:(\d{1,3}\.…)$`. The WHATWG URL parser canonicalizes `[::ffff:127.0.0.1]` to the
  **hex-compressed** `::ffff:7f00:1`, which matches neither that regex nor the `::1`/`fe80:`/`fc`/`fd`
  checks → mapped-IPv6 loopback, RFC-1918, and `169.254.169.254` are **not** blocked, contradicting
  the documented D3 intent.
- **Evidence (verified live with Node):**
  ```
  new URL("https://[::ffff:127.0.0.1]/x").hostname       => "::ffff:7f00:1"      blocked? false
  new URL("https://[::ffff:169.254.169.254]/x").hostname => "::ffff:a9fe:a9fe"   blocked? false
  ```
  Reachability: a model manifest `download.url` is validated only by `isHttpsUrl` (any https host),
  `model-manifests/` is documented as user-/attacker-writable on a removable drive, and a redirect
  `Location:` re-validates through the same gap.
- **Consequences:** The exact SSRF class D3 was written to close — a blind GET aimed at the
  desktop's loopback services, a LAN device, or the cloud-metadata endpoint. Exfil-limited (a blind
  GET that streams to `.part` then fails SHA verify), requires the network gates open + a
  per-download confirmation — but a real bypass of a purpose-built control.
- **Recommended fix:** Normalize the mapped form before range-testing (reconstruct dotted IPv4 from
  the hex hextets and recurse), or simplest robust hardening: **reject any download host containing
  `::ffff:`** and deny bare IPv6-literal hosts unless explicitly needed.
- **Testing needed:** Unit tests on `isPrivateOrLoopbackHost`/`assertSafeDownloadUrl` for
  `[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]`, `[0:0:0:0:0:ffff:127.0.0.1]`; a redirect-hop
  test; a positive control that a legitimate public https host still passes.
- **Doc updates:** security-model.md §D3 + architecture.md §25/§26 SSRF lines.

### F16 — IPC lock-guard coverage is overstated; several DB-touching handlers lack the explicit `requireUnlocked()` preamble
> **✅ REMEDIATED — Phase 4 (branch `audit-postmerge-phase4-security-consistency`).** Added the localized
> `requireUnlocked()` preamble to the four DB-touching groups — `registerRagIpc` (rag:ask, reuses
> `main.chat.locked`), `registerAuditIpc` (`main.audit.locked`), `registerCoreIpc` settings get/update
> (`main.settings.locked`), `registerModelIpc` list/select/verify/start (`main.models.locked`) — and
> **generalized** TEST-N8 into `tests/integration/ipc-lock-coverage.test.ts`, which drives the
> core/model/audit/rag/benchmark/collections modules against a locked ctx (refusal enumerated; a missing
> guard reddens it) and asserts the read-only channels (`getLogTail`/`getRuntimeStatus`) still resolve when
> locked. The §25 "enumerates them" wording is corrected. **This generalized test SUBSUMES Phase-5 item T3
> (rag:ask lock-rejection).** Disposition: architecture.md §30 + §25 inventory correction.
- **Category:** Security (defense-in-depth + doc accuracy)
- **Severity:** Low · **Confidence:** High
- **Location:** `registerRagIpc.ts` (0 `requireUnlocked()`; first DB touch `ctx.db` at line 129),
  `registerAuditIpc.ts`, `registerCoreIpc.ts` (settings), `registerModelIpc.ts`. Doc claim:
  architecture.md §25 ("every DB-touching handler is guarded; TEST-N8 enumerates them")
- **Description:** The ledger says every DB-touching handler is guarded **and that the structural
  test enumerates them**. In fact TEST-N8 enumerates only `registerChatIpc` + the two benchmark
  handlers. The audit/core-settings/model/rag handlers touch `ctx.db` with **no** explicit
  `requireUnlocked()`. They remain **fail-closed** — `ctx.db` is a getter over `requireDb()` which
  throws when locked → **no data leak** — but (a) they surface the raw unlocalized "Workspace is
  locked" instead of the friendly localized copy (the inconsistency SEC-N2 fixed for benchmark), and
  (b) the "enumerates them" claim is not literally true, so a future handler reaching the DB through
  a non-throwing path would slip the net.
- **Recommended fix:** Add the localized `requireUnlocked()` preamble to the
  audit/core-settings/model/rag DB-touching handlers, **or** generalize TEST-N8 to drive *every*
  `register*Ipc` module against a locked ctx. Correct the §25 wording either way.
- **Testing needed:** Extend the structural locked-vault test across all `register*Ipc` modules;
  assert read-only/in-memory channels (`getLogTail`, `getRuntimeStatus`) still resolve when locked.
- **Doc updates:** architecture.md §25 inventory line on TEST-N8.

### F17 — Engine download applies no caller-side size cap; model download falls back to the 64 GiB backstop when `size_bytes` is absent
> **✅ REMEDIATED — Phase 4 (branch `audit-postmerge-phase4-security-consistency`).** Both downloaders now
> ALWAYS pass a bounded cap: the engine path passes `ENGINE_DOWNLOAD_MAX_BYTES` (2 GiB), the model path
> passes the manifest's exact `size_bytes` when known else a bounded per-role default (`modelWeightMaxBytes`:
> chat/vision 40 GiB, transcriber 8 GiB, embeddings/reranker 4 GiB). `DOWNLOAD_HARD_MAX_BYTES` lowered
> 64→48 GiB (now unreachable from production). The cap policy is extracted to the unit-testable
> `effectiveDownloadCap`. Tests: `assets.test.ts` (pure helpers) + `downloads.test.ts` / `engine-download.test.ts`
> (injected `downloadImpl` captures the applied cap). Disposition: architecture.md §30; security-model.md §D3.
- **Category:** Security (resource exhaustion / disk-fill)
- **Severity:** Low · **Confidence:** High
- **Location:** `runtime-download.ts` (never passes `maxBytes`); `downloads.ts:328` (passes
  `maxBytes` only when `task.sizeBytes != null`); cap + 64 GiB backstop at `assets.ts:499-502` /
  `:398`
- **Description:** `downloadToFile`'s effective cap is `min(Content-Length, maxBytes) + margin`, else
  `DOWNLOAD_HARD_MAX_BYTES = 64 GiB`. The model downloader passes `maxBytes` only when the manifest
  carries `size_bytes` (optional); the engine downloader passes **no** `maxBytes` at all. A
  redirected/hostile endpoint that also omits `Content-Length` collapses the cap to 64 GiB.
- **Consequences:** Up to ~64 GiB streamed onto a portable drive before the cap fires — a disk-fill
  nuisance DoS on small USB drives. Requires network gates open + per-download confirmation; the
  bytes fail SHA verify afterward (no integrity loss).
- **Recommended fix:** Have the engine downloader pass a bounded per-family ceiling; for the model
  path, apply a role-based default ceiling when `size_bytes` is absent rather than the 64 GiB
  backstop. Consider lowering `DOWNLOAD_HARD_MAX_BYTES`.
- **Testing needed:** A `downloadToFile` test with no `Content-Length` and no `maxBytes` asserting
  the cap fires; an engine-download test asserting a bounded cap.
- **Doc updates:** security-model.md §D3 — note the engine-path / no-`Content-Length` residual.

### F18 — `VisionService` terminal `done` write bypasses the cancelled-guard (latent)
- **Category:** Concurrency
- **Severity:** Low · **Confidence:** Medium (not currently reachable)
- **Location:** `apps/desktop/src/main/services/vision/index.ts` (~line 132, the `done` job write)
- **Description:** The success-path `this.jobs.set(jobId, done)` writes the terminal state directly,
  not through the `set()` helper that guards against resurrecting a `cancelled` job. Safe today
  (reached only when `signal.aborted` was false one statement earlier, no `await` between) but a
  refactor inserting an `await` there would let a concurrent `cancel()` be silently overwritten by
  `done` and re-fire `emit.done`.
- **Recommended fix:** Route the terminal write through the cancelled-guarded `set()` helper.

### F19 — Workspace-lock `suspend()` lacks the `stopped`-style race guard that protects `stop()`
- **Category:** Concurrency
- **Severity:** Low · **Confidence:** Low (hypothesis — no definitely-reachable trigger constructed)
- **Location:** `embeddings/e5.ts:261-282` / `reranker/llama.ts:229-242` (`suspend()`/`teardown()`);
  lock sequence `registerWorkspaceIpc.ts:224-246`
- **Description:** `stop()` sets `this.stopped = true` before `teardown()`, closing the orphan
  window; `suspend()` (the lock path) sets no such latch. If a `suspend()` interleaves with a
  concurrent `embed()`/`rerank()` (RAG query embedding and tree-build embedding are not in
  `inFlightStreams` and `abortActiveBuild()` is cooperative), `teardown()` could complete as a no-op
  while a fresh sidecar spawns and is retained — surviving the lock with plaintext-derived chunk
  text in process memory.
- **Recommended fix:** Add a `tearingDown` flag set at the top of `teardown()` and re-checked after
  `await this.starting`; have `ensureStarted` refuse while it is set — give `suspend()` the same
  protection `stop()` gets from `stopped`.
- **Testing needed:** Deterministic interleave: a `teardown()` whose `await this.starting` resolves
  while a concurrent `ensureStarted` assigns `this.starting`; assert no retained server after
  suspend.

### F20 — First-run gate does not move focus on phase transitions (accessibility)
- **Category:** Accessibility
- **Severity:** Medium · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/screens/WorkspaceGate.tsx` (phase transitions
  `welcome → password → finishing → starter`; `setPhase('password')` at :203)
- **Description:** The create flow swaps the entire card per `phase` but steers focus only with
  scattered `autoFocus`. The critical gap is `welcome → password`: the welcome CTA has `autoFocus`
  but the password-phase field does **not** (only the *unlock*-path field, :174, does). A
  keyboard/SR user who activates "Get started" lands with focus reset to `<body>` and the
  most security-sensitive screen (password creation) announces nothing. WCAG 2.4.3 / 3.2.2.
- **Recommended fix:** `useEffect(() => ref.current?.focus(), [phase])` targeting each step's
  primary interactive element (password input on `password`, primary button on
  `finishing`/`starter`); keep the welcome CTA `autoFocus`.
- **Testing needed:** A `WorkspaceGate` test advancing `welcome → password` asserting
  `document.activeElement` is the password input; manual NVDA/keyboard walk.
- **Doc updates:** architecture.md renderer record (FE cluster); known-limitations §Accessibility if
  deferred.

### F21 — Microphone stream leaks if the component unmounts while `getUserMedia` is pending
- **Category:** FE-lifecycle
- **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/chat/DictationButton.tsx:69-81` (`start`), unmount cleanup
  `:61-67`
- **Description:** `start()` assigns `captureRef.current` only **after** `await captureDictation()`.
  If the user navigates away while the OS mic prompt is open, cleanup runs first (sees
  `captureRef.current === null`), then `start()` resolves, acquires a live `MediaStream` +
  `AudioContext`, stores it on the unmounted component, and never `.stop()`s it — the **OS recording
  indicator stays on** until GC. Alarming in a privacy-first app.
- **Recommended fix:** Track a `mountedRef`; after the `await`, if unmounted, immediately
  `capture.cancel()` and don't store it (mirror the ChatScreen/DocumentsScreen `mountedRef`).
- **Testing needed:** Resolve an injected `captureImpl` *after* unmount; assert `cancel()` was
  called.

### F22 — ModelsScreen download/engine poll setState (+ `refresh()`) without the FE-4 unmount guard
- **Category:** FE-lifecycle
- **Severity:** Low · **Confidence:** High
- **Location:** `apps/desktop/src/renderer/screens/ModelsScreen.tsx:165-205` (the two polling
  effects); the `DiagnosticsTab` `loadActivity`/`loadMoreActivity` share the class
- **Description:** Both poll effects clear their interval on unmount, but a parked
  `getDownloadJob`/`getEngineJob` promise can resolve after teardown, running `setJob(next)` and (on
  a transition) `void refresh()` (5+ setStates). Silent no-ops under React 18 today, but the lone
  hold-out from the codebase's uniformly-applied FE-4 `mountedRef` discipline (which architecture.md
  claims is uniform) — a latent footgun under stricter modes.
- **Recommended fix:** Add `let active = true` (or component `mountedRef`) checked before
  `setJob`/`refresh` in both callbacks (and the DiagnosticsTab refreshers).
- **Testing needed:** Unmount a ModelsScreen with a job tick in flight; assert no `setJob` after
  unmount.
- **Doc updates:** Narrow the FE-4 "applied uniformly" claim or fix the hold-outs.

### F23 — `StreamAnnouncer` live region uses `aria-atomic="true"`, re-announcing the whole buffer each flush
- **Category:** Accessibility
- **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/chat/Transcript.tsx:370-374`
- **Description:** The announcer carefully feeds only newly-completed sentences into a `role="log"
  aria-live="polite"` region, but `aria-atomic="true"` tells the AT to re-read the **entire** region
  on every change — semantically wrong for an additive log and can cause double-speak on rapid
  sentence boundaries.
- **Recommended fix:** Drop `aria-atomic` (or set `="false"`); verify single-sentence announcement
  with NVDA/VoiceOver.

### F24 — `Composer.insertDictation` schedules an uncleared `setTimeout(…, 0)` in the fallback path
- **Category:** FE-lifecycle
- **Severity:** Low · **Confidence:** Medium
- **Location:** `apps/desktop/src/renderer/chat/Composer.tsx:106-108`
- **Description:** The non-`execCommand` fallback (jsdom) defers caret restoration via an untracked
  `setTimeout`. Benign (the `ref.current?.` deref is guarded and this path doesn't run in the real
  Electron renderer where `execCommand` succeeds) — listed for the codebase's own timer-cleanup
  consistency only. Lowest priority.

---

## 3. Documentation audit

The doc set is **exceptionally accurate** — ~70 numeric constants cross-checked with **zero
mismatches**, the prior DOC-2/DOC-3 fixes landed, all §-anchor legends resolve, doc-lifecycle
compliance is clean (the only plan file is the legitimately-open `big-slot-embeddings-plan.md`; the
prior audit report was correctly retired). The issues below are contradictions/staleness, not gaps.

| ID | Finding | Sev | Location |
|----|---------|-----|----------|
| **D1** | The **TEST-6 record (written during the prior audit) is already stale** — it says the S13b skill-trigger precision bar is "owner-gated on D1 / not asserted," but `skill-triggers.test.ts:150-163` now **asserts `firedWrong===0` AND `precision ≥ 0.95`** in CI (committed `7d7c7a1`). The remaining gap is narrower (RAG *answer* quality + real-model output, still env-gated). | Medium | architecture.md:3966/4054-4056; BUILD_STATE TEST-6 bullet |
| **D2** | `known-limitations.md` lists as an open DIY gap that the in-app downloader "drives only `tasks[0]` (the GGUF)" — the **code fetches both** GGUF + mmproj as one job (`downloads.ts:263-298`, passing test `downloads.test.ts:268`). Contradicts user-guide §8. | Medium | known-limitations.md:714-716 |
| **D3** | Reranker documented "**never bundled by default**" (model-policy.md:33, rag-design.md:840) but it **IS** in the `--with-assets` `DEFAULT_MODEL_IDS` (`prepare-drive.ps1:77`/`.sh:33`) and README/packaging/drive-layout all list it. The `bundled_on_preconfigured_drive:false` flag is unused in code. | Medium | model-policy.md:33; rag-design.md:840 |
| **D4** | Stale "**60 s health timeout**" comment in `gpu-smoke.test.ts:31` (code is 180 s) — the DOC-2 fix didn't sweep test comments. | Low | gpu-smoke.test.ts:31 |
| **D5** | New **dangling `§9` citation** in `assets.test.ts:265` ("GPU record §6/§9"; the GPU record ends at §8) — structurally identical to the §11.1 trio but not named by the prior sweep. | Low | assets.test.ts:265 |
| **D6** | The two **pre-existing dangling `§11.1`** citations (`gpu.test.ts:13`, `runtime-ladder.test.ts:13`) remain (the §26 ledger admits them). Together with D4/D5, **four** stray test-comment fragments are cleanable in one pass. | Low | gpu.test.ts:13; runtime-ladder.test.ts:13 |
| **D7** | Whisper **real-time-factor figures inconsistent** across docs/manifest (0.46 / 0.5 / 0.67; the "52 min → 35 min" example matches none). | Low | known-limitations.md:582/621; user-guide.md:417; whisper manifest:15 |
| **D8** | README "**~3 GB smallest setup**" inconsistent with the documented `--with-assets` default (~7–11 GB) — a user sizing a drive from the 3 GB line may under-provision. | Low | README.md:82-84 vs :127-136 |

**Missing docs:** none material. The one structural absence worth recording is that there is **no
automated full-stack e2e** (no Playwright/Electron-launch test in CI; the `walk-*.mjs` are manual
screenshot recipes) — a reasonable posture for an offline app, but it should be stated in the
testing doc so it is a conscious decision, not an assumed gap.

---

## 4. Testing audit

**Strengths.** This is a strong, disciplined suite (2463/39 green, independently re-run). The
high-risk controls are **genuinely teeth-checked** — `binary-verify-spawn` drives the real verifier
at all three seams with a real hash-mismatched marker + positive control; the whisper
SIGTERM-ignore escalation uses a faithful `makeStubbornChild`; PERF-1 equivalence reads back rowids
to prove the same-rowid-reuse case is real; the RAG grounding contract asserts model-never-called
on every empty/stale/scoped branch; crypto covers wrong-key/bit-flip/short-header/KDF-bounds. The
`FullSuiteGuard` (turns a silently-dropped suite into a hard non-zero exit) is an excellent
false-green defense. Env-gating of real-model/real-data via `describe.runIf` (files stay
*collected* so the guard counts them) is sound.

**Weaknesses — the seams where a control is correct but a future unwiring would redden nothing.**

| ID | Finding | Sev | Location |
|----|---------|-----|----------|
| **T1** ✅ | `sidecar.test.ts` `FakeChild` **exits on ANY signal** → the LlamaServer **unit** suite can never exercise the SIGTERM-ignore→SIGKILL escalation (only the integration tier does). A regression re-gating escalation on `child.killed` instead of `this.exited` reddens nothing in the file that appears to own LlamaServer lifecycle. **CLOSED (Phase 5)** — new unit test with a stubborn child (records signals, dies only on SIGKILL) asserts `signals == [undefined,'SIGKILL']`; teeth-checked by reverting the line-576 gate. | Medium | tests/unit/sidecar.test.ts:27-35 |
| **T2** ✅ | **Resident-cache lock-purge** (a stated security requirement) is wired but **never asserted at the IPC layer** — `workspace-ipc.test.ts` lock tests assert the sidecar stops fired but never that `purgeResidentVectors` ran. A refactor dropping the purge leaves plaintext-derived vectors resident after lock with zero failure. **CLOSED (Phase 5)** — the lock IPC test seeds a real resident map and asserts the purge fired against the live db (spy delegates to the real impl); teeth-checked by dropping the purge call. | Medium | tests/integration/workspace-ipc.test.ts:150-204 |
| **T3** ✅ | **`registerRagIpc` (rag:ask)** had **no lock-gate and no lock-rejection test** — the only DB-touching streaming handler without either (relied on the `ctx.db` getter throwing raw English). **SUBSUMED (Phase 4)** — F16 added the localized `requireUnlocked()` to rag:ask and the generalized `ipc-lock-coverage.test.ts` drives it against a locked ctx; no separate Phase-5 test needed. | Medium | src/main/ipc/registerRagIpc.ts |
| **T4** ✅ | **Parens-negative money** is only tested as a bare token (`parseAmount('(45.00)')`), never through the real `MONEY_RE` scanner — the whole-string treatment BL-1 got but parens-negative didn't. **ADDRESSED (Phase 1)** — pinned through `extractTransactionRows`. | Medium | tests/unit/skills-bank-statement-tool.test.ts:73 |
| **T5** ✅ | **Amounts with 3+ decimals** have unpinned behavior; the load-bearing "every figure is 2-dp" integer-cent invariant (`Math.round(x*100)`) is **never enforced by a test** (a 3-dp token silently drops its third decimal). **FIXED + PINNED (Phase 1)** — `parseAmount` rounds to nearest cent; tested. | Medium | money.ts:81-119 (no covering test) |
| **T6** ✅ | **GPU-probe timeout test uses real wall-clock** (`timeoutMs:20` + real setTimeout) — a TEST-1-family flake surface. **CLOSED (Phase 5)** — converted to fake timers (`vi.advanceTimersByTimeAsync`); kill-on-timeout assertion preserved + teeth-checked. | Low | tests/unit/gpu.test.ts:178-187 |
| **T7** ✅ | **Iteration-capped poll** in `skills-privacy-guard.test.ts:334-337` (`for(i<50){sleep(5)}`) — a structural TEST-1 sibling; plus redundant real-timer copies in `vision-runtime.test.ts`. **CLOSED (Phase 5)** — the privacy-guard poll converted to `vi.waitFor`; the optional vision-runtime copies left (need the fakeClock seam). | Low | tests/integration/skills-privacy-guard.test.ts:334 |
| **T8** ✅ | `runtime-manager.test.ts` crash-fallback **counts a monkey-patched `stop()` wrapper, not the child kill** — a regression where `stop()` no longer reaches the kill (orphan) still satisfies the assertion. **CLOSED (Phase 5)** — added a final `mgr.stop()` + `children[1].child.killed===true` (the LIVE restarted child's real reap; the crashed child already exited so `stop()` correctly skips it — DIVERGED from the literal "crashed child killed===true"); teeth-checked. | Low | tests/integration/runtime-manager.test.ts:359-367 |
| **T9** ⚑ | Nits: `BANK_EXTRACTOR_VERSION` tripwire is borderline-tautological; **invoice negative line totals / credit notes (Gutschrift/Rabatt) untested** *(✅ now covered — Phase 1)*; AES-GCM decrypt never tested against a truncated ciphertext at the unit tier *(✅ now covered — Phase 5: `crypto.test.ts`)*; the mock-embedder's clean geometry never reproduces real E5's compressed score band (the RAG-1 tiebreak's reason for existing) *(left, accepted)*. | Low | various |

**Guidance to avoid over-mocking (carry forward):** (1) a fake standing in for something whose
*misbehavior* is the threat must be able to *exhibit that misbehavior on demand* (T1 — a child that
exits on any signal can't test signal-ignore escalation; model it like `RecordingChild(exitOn)` /
`makeStubbornChild`). (2) Test through the real seam, inject only at the boundary (the TEST-2/REL-1
pattern); never inject a fake *verdict* that proves only the verdict→action mapping. (3) Assert
parsed/observed values, not pre-isolated inputs (T4/T5 — feed whole strings through the real
extractor). (4) Co-locate teeth where a reader expects them (T1/T2/T3 — the control is tested/wired,
just not where a refactorer of that file/module would look). (5) Replace iteration-capped polls with
`vi.waitFor` or wall-clock deadlines (T6/T7).

---

## 5. Performance audit

The app is CPU-target and the prior PERF-1 work removed the one real per-write scalability ceiling
(verified). Remaining items are bounded:

- **F12 (Low)** — the incremental reconcile still pays an unmeasured O(N) `SELECT chunk_id` id-scan
  + Set build on the first query after every write; mitigate with an adds-only fast path or a
  pending-delta set, and add the reconcile leg to the benchmark.
- **F13 (Low, latent)** — `minSimilarity` after the `topKInitial` cut wastes recall once a floor is
  re-enabled (precondition of the deferred E5-prefix work).
- **PERF-5 Part B / FE-5 list windowing (known-deferred)** — concrete bite points are **Documents**
  (`DocumentsScreen.tsx:1024`, unbounded `DocRow` mount) and the **Diagnostics activity list**
  (grows via load-more); the Transcript mounts all turns but is mitigated for *streaming* re-renders
  (MessageBlock memo + plain-text live bubble). Per-row memoization keeps re-render cost down; only
  initial mount + DOM node count is unbounded. When picked up, Documents + Diagnostics are the
  highest-value windowing targets.
- **No unnecessary-render storms found** in the streaming hot path (verified the memo boundaries).
- **No expensive synchronous main-thread SQL** beyond F12; all transactions are synchronous
  node:sqlite with no `await` inside (REL-5 invariant verified).

**Validation approach:** for F12, benchmark the reconcile at N=100k (mark dirty + 1-row add) and
confirm the id-scan time; for list windowing, measure first-paint + DOM node count on a
1000-document corpus before/after.

---

## 6. Phased remediation plan

Each phase is sized for a fresh Claude Code session. Every implementation phase ends with the
mandatory per-phase ritual (tests green, app builds, docs updated, BUILD_STATE updated, commit
referencing the phase). Characterization tests are written **before** the behavior change where the
current behavior is load-bearing (financial parsing especially).

### Phase 1 — Invoice + bank money-parser correctness (the release-blocker class) ⭐ FIRST — ✅ DONE
> **✅ COMPLETE (branch `audit-postmerge-phase1-money`).** F1/F3/F6/F8 + the invoice single-currency guard +
> the T5 2-dp invariant + T4/T9 characterization all landed test-first; suite 2483/39, typecheck + build
> green. The F1 bank drop was made **statement-context-aware** (diverged from the literal recommendation) to
> avoid regressing the HVB no-balance numeric-payee format. Disposition: architecture.md §27 + §8.
- **Goal:** eliminate confidently-wrong money. Close F1, F3, F6, F8 and the invoice single-currency
  guard.
- **Scope/files:** `skills/tools/bank-statement.ts`, `skills/tools/invoice.ts`, `skills/tools/money.ts`,
  `skills/analysis/invoice.ts` (validate path).
- **Steps:** (1) **Characterize first** — add whole-string `extractTransactionRows` /
  `parseLineItem` tests pinning today's behavior for parens-negative (T4), 3-dp (T5), whole-euro,
  single-decimal, space-column, and qty-coded inputs (these will initially encode the *bugs* —
  label them). (2) Fix F1: drop a row whose figure region has unmatched digit-runs left of the lone
  money token (or widen `MONEY_RE` inside the figure region) — apply to both parsers; flip the F1
  characterization assertions to the correct values. (3) Fix F3: `detectCurrency` on the
  figure-region slice + single-currency guard in `validateInvoiceTotals`. (4) Fix F6/F8 on the
  invoice path (drop fused/ambiguous rows; require a unit token for qty split). (5) Pin the 3-dp /
  2-dp invariant (T5) explicitly.
- **Tests:** the above characterization-then-correct set + invoice negative line totals (T9).
- **Docs:** known-limitations BL bullets (F1/F3/F6/F8/F10), architecture.md §8 + a new §-ledger
  entry.
- **Acceptance:** every new money test green; the balance magnitude never appears as `amount`;
  mixed-currency invoice totals return `unknown`; full suite green.
- **Risk/rollback:** parser changes are behavior-sensitive — the characterization-first ordering is
  the safety net; each fix is one commit, revertable independently.

### Phase 2 — Chat regenerate data-loss + sidecar bind-race reliability — ✅ DONE
> **✅ COMPLETE (branch `audit-postmerge-phase2-runtime-reliability`).** F2/F4/F7/F9 all landed test-first
> (red→green); suite **2492 passed / 39 skipped**, typecheck + build green. No schema/IPC-channel/audit-payload
> change. F2 reuses the REL-3 slot semantics (delete deferred into `withChatStream`'s `runFn` + byte-faithful
> restore on a non-abort failure, both channels); F4/F7 reuse the REL-1 `isBindRaceError` classifier in the
> start-latch. Disposition: architecture.md §28 + "Chat & streaming" + GPU record §5.5b.
- **Goal:** close F2, F4, F7, F9.
- **Scope/files:** `ipc/registerChatIpc.ts`, `ipc/registerRagIpc.ts`, `services/chat.ts`,
  `embeddings/e5.ts`, `reranker/llama.ts`, `chat/compaction.ts`.
- **Steps:** (1) F2: defer the regenerate DELETE into `withChatStream`'s `runFn` (or snapshot +
  restore on non-abort failure); apply to both channels. (2) F4/F7: in the embedder + reranker
  start-latch `.catch`, skip arming `startFailed` when `isBindRaceError(err.message)`. (3) F9: log
  the non-abort compaction failure.
- **Tests:** regenerate-where-generate-throws-400 keeps/restores the prior reply; double-bind-race
  leaves `startFailed` null and a later `embed()`/`rerank()` retries; compaction non-abort error
  logs `warn`.
- **Docs:** architecture.md "Chat & streaming" (regenerate ordering) + known-limitations (embedder
  transient latch).
- **Acceptance:** the three new behaviors proven test-first (red→green); full suite green.
- **Risk:** F2 touches the chat hot path — keep the slot/stream semantics identical, change only the
  delete ordering.

### Phase 3 — Invoice data lifecycle (reuse/replace parity with bank)
> **✅ COMPLETE (branch `audit-postmerge-phase3-invoice-lifecycle`).** F5 closed by mirroring the bank
> reuse/replace/staleness machinery onto the invoice path: additive nullable `invoices.extractor_version`,
> `INVOICE_EXTRACTOR_VERSION` + `isInvoiceStale`, and `replaceExisting` (atomic delete-then-insert inside the
> existing `BEGIN/COMMIT`). Suite **2495 passed / 39 skipped**, typecheck + build green. Durable record:
> architecture.md §29 + §8 (invoice reuse/replace/staleness parity); §27 ledger F5 row flipped to fixed.
- **Goal:** close F5.
- **Scope/files:** `skills/invoice-run.ts`, `skills/analysis/invoice.ts`, schema (add
  `extractor_version` to `invoices`), `skills/run.ts` (purge ordering).
- **Steps:** add `INVOICE_EXTRACTOR_VERSION` + `isInvoiceStale`; reuse the latest invoice when
  present and fresh, else `replaceExisting`-delete-then-insert in FK order inside the existing txn.
- **Tests:** two analysis questions over one document → exactly one `invoices` row + one line-item
  set; a version bump forces re-extract.
- **Docs:** architecture.md §8 (invoice/bank parity).
- **Acceptance:** no table growth across repeated questions; full suite green.

### Phase 4 — Security consistency hardening — ✅ DONE
> **✅ COMPLETE (branch `audit-postmerge-phase4-security-consistency`).** F15/F14/F16/F17 all landed
> test-first (red→green); suite **2515 passed / 39 skipped**, typecheck + build green. F15 denies any
> `::ffff:` host; F14 zeroes the log buffer on lock (option a); F16 added the localized `requireUnlocked()` to
> the four DB-touching groups + a generalized structural lock test (**subsumes T3**); F17 makes both
> downloaders always pass a bounded cap (engine 2 GiB; model exact-size-or-per-role-default). The optional
> SEC-1 code half / SEC-2 / SEC-3 were **NOT** taken in this phase (left for their own phase). Disposition:
> architecture.md §30 + §27 ledger row; security-model.md §D3 + "encrypted log" record + §25 inventory fix.
- **Goal:** close F15, F14, F16, F17 (and optionally the §26-deferred SEC-1 code half / SEC-2 / SEC-3).
- **Scope/files:** `services/assets.ts`, `services/logging.ts`, `services/runtime-download.ts`,
  `services/downloads.ts`, `ipc/registerRagIpc.ts` + `registerAuditIpc.ts`/`registerCoreIpc.ts`/
  `registerModelIpc.ts`.
- **Steps:** (1) F15: normalize/reject the mapped-IPv6 form in `isPrivateOrLoopbackHost`. (2) F14:
  zero the log buffer in `detachVaultKey()` after the final flush (or gate the two IPCs when
  locked). (3) F16: add the localized `requireUnlocked()` preamble to the four handler groups **and**
  generalize the TEST-N8 structural lock test across all `register*Ipc` modules; correct the §25
  wording. (4) F17: bound `maxBytes` on the engine + size-absent model download paths.
- **Tests:** SSRF unit tests for all mapped-IPv6 spellings + a redirect hop + a public-host positive
  control; log-tail empty/absent after lock; the generalized locked-vault IPC enumeration; a
  download size-cap test with no `Content-Length`.
- **Docs:** security-model.md §D3 + the log-lifecycle section; architecture.md §25 inventory.
- **Acceptance:** mapped-IPv6 internal hosts blocked; full suite green.

### Phase 5 — Test-enforcement seams (prove the controls stay wired) — ✅ DONE
> **✅ COMPLETE (branch `audit-postmerge-phase5-test-seams`).** T1/T2/T6/T7/T8 closed + T9 truncated-ciphertext
> nit added; T3 verified subsumed by F16. Suite **2518 passed / 39 skipped**, typecheck + build green, **`git
> diff src/` empty**. Every wiring proof (T1/T2/T8) teeth-checked (one-line neuter → red → restore byte-
> identical); T6/T7 de-flaked (fake timers / `vi.waitFor`, verified stable across runs). **T8 DIVERGED** from
> the literal "crashed child killed===true" — the crashed child already exited so `stop()` correctly skips its
> kill (asserting true reds on correct code); the real-reap assertion is on the LIVE restarted child instead.
> Disposition: architecture.md **§31 ledger** + the "Test-enforcement seams" record (Phase-5 subsection).
- **Goal:** close T1, T2, T3, T6, T7, T8 (T4/T5 land in Phase 1; this phase is the wiring proofs).
- **Scope/files:** `tests/unit/sidecar.test.ts`, `tests/integration/workspace-ipc.test.ts`,
  `tests/integration/rag-*`/`*-ipc`, `tests/unit/gpu.test.ts`, `skills-privacy-guard.test.ts`,
  `runtime-manager.test.ts`. **Test-only — no `src/` change** (except T3 may add a `requireUnlocked`
  in Phase 4).
- **Steps:** (1) T1: a LlamaServer unit test with a stubborn child (SIGTERM records, only SIGKILL
  exits) asserting `signals == [undefined,'SIGKILL']`; teeth-check by reverting the `this.exited`
  gate. (2) T2: spy `purgeResidentVectors` (or seed a resident map) in the `lockWorkspace` IPC test.
  (3) T3: a `rag:ask` lock-rejection integration test. (4) T6/T7: convert wall-clock/iteration polls
  to `vi.waitFor`/fake timers. (5) T8: also assert the crashed child's `killed===true` after
  restart.
- **Acceptance:** each new test teeth-checked (neuter the control → reddens → restore); full suite
  green; `git diff src/` empty.

### Phase 6 — Frontend accessibility + lifecycle consistency
- **Goal:** close F20, F21, F22, F23, F24.
- **Scope/files:** `renderer/screens/WorkspaceGate.tsx`, `renderer/chat/DictationButton.tsx`,
  `renderer/screens/ModelsScreen.tsx` (+ DiagnosticsTab), `renderer/chat/Transcript.tsx`,
  `renderer/chat/Composer.tsx`.
- **Steps:** (1) F20: phase-change focus management. (2) F21: `mountedRef` cancel-on-unmount for the
  mic capture. (3) F22: FE-4 guard on the ModelsScreen polls + Diagnostics refreshers. (4) F23: drop
  `aria-atomic`. (5) F24: clear the Composer fallback timer (lowest priority).
- **Tests:** WorkspaceGate focus-after-phase-change; DictationButton cancel-after-unmount;
  ModelsScreen no-setState-after-unmount.
- **Docs:** architecture.md renderer FE record (narrow/confirm the FE-4 "uniform" claim).
- **Acceptance:** keyboard/SR walk of the first-run flow lands focus correctly; full suite green.

### Phase 7 — Documentation reconciliation
- **Goal:** close D1–D8 + the F11/F13 doc notes. **Docs/comments-only — no behavior change.**
- **Scope/files:** architecture.md (TEST-6 record, §25 inventory), known-limitations.md, model-policy.md,
  rag-design.md, README.md, the four stray test-comment fragments (gpu.test.ts, runtime-ladder.test.ts,
  assets.test.ts, gpu-smoke.test.ts), the whisper RTF figures.
- **Steps:** correct the stale TEST-6 claim (S13b bar IS live), the vision-download limitation, the
  reranker "never bundled" contradiction, the four dangling-citation/60 s fragments, the RTF
  inconsistency, the README 3 GB framing; add the F11 provenance-citation distinction and the F13
  floor-ordering caveat.
- **Acceptance:** §-anchor sweep clean; no doc/code numeric or claim contradiction remains.

### Phase 8 — RAG/perf + latent-concurrency low-hangers
- **Goal:** close F12, F18, F19 (and the F11 renderer half if not handled in Phase 7).
- **Scope/files:** `embeddings/resident-cache.ts` (+ bench), `vision/index.ts`, `embeddings/e5.ts` /
  `reranker/llama.ts` (`tearingDown` guard), optionally `whole-doc-tree.ts` provenance cap.
- **Steps:** F12 adds-only fast path + reconcile benchmark leg; F18 route the terminal write through
  the guarded `set()`; F19 add the `tearingDown` race guard to `suspend()`/`teardown()`.
- **Acceptance:** reconcile benchmark recorded; teeth on the new guards; full suite green.

---

## 7. Recommended execution order & dependencies

1. **Phase 1 (money) first — non-negotiable.** F1 is the only High; confidently-wrong money is the
   app's cardinal harm and the fix is parser-local and well-bounded by characterization tests.
2. **Phase 2 (regenerate data-loss + bind-race latch)** next — F2 is reachable user-facing data loss;
   F4 silently disables indexing. Both are "apply the fix that already exists next door." Independent
   of Phase 1.
3. **Phase 3 (invoice lifecycle)** — depends on Phase 1 being in the invoice file (lower merge
   churn), otherwise independent.
4. **Phase 4 (security consistency)** — independent; can run in parallel with 1–3. F15 (SSRF) is the
   most concrete item here.
5. **Phase 5 (test seams)** — independent and low-risk (test-only); can run anytime, ideally before
   or alongside the phases whose controls it pins (T2 with Phase 4's lock work, T1 anytime).
6. **Phase 6 (frontend a11y)** — fully independent of all backend phases.
7. **Phase 7 (docs)** — fully independent; can be done first or last. D1 (stale TEST-6 record) is
   worth correcting early so a follow-up session doesn't duplicate the S13b gate.
8. **Phase 8 (low-hangers)** — last; no dependencies, lowest user impact.

**Cross-cutting dependency:** the **deferred E5 `query:`/`passage:` prefix migration** (its own
phase, carried from §25) must land **F13 (floor-before-cut)** as part of it — record this as a
precondition so the floor re-enable doesn't silently cost recall.

**Carried-forward §26 deferrals (re-verified, still valid):** SEC-1 code half / SEC-2 / SEC-3 (fold
into Phase 4 if desired), **REL-5** (`BEGIN IMMEDIATE` + `withTransaction` — the no-`await`-in-txn
invariant was **re-verified true at every BEGIN site**, so this stays a defense-in-depth margin, its
own characterized phase), **PERF-5 Part B** list windowing (Phase 6/8 candidate when picked up).

---

## Appendix — confirmed-clean inventory (checked, no action)

Crypto/vault internals; skills installer/trust/registry/selector/autofire (ReDoS-safe glob matcher,
deny-by-default trust gate, prototype-pollution-free manifest validator); binary verify at all spawn
seams; Electron CSP/isolation/sandbox/navigation; offline guard (only mapped-IPv6 leaks, F15);
`LlamaServer`/GPU/transcriber lifecycle (REL-1/2 in place); slot arbiter REL-3; `combineSignals`
REL-4; all BEGIN/COMMIT synchronous (REL-5 justified); vector codec; PERF-1 byte-equivalence;
RAG grounding/honesty contract; FTS triggers; chunker token-counting + over-cap fail-closed;
`deleteDocument` atomicity (DATA-1); renderer markdown XSS surface; `data:`-only image preview;
`subscribeVisionPersisted`/WorkspaceGate unsubscribe; `doc-lock` FIFO mutex; ~70 documented
constants. The prior BL-1/2/3, REL-1/2/3/4, PERF-1, RAG-1/2, FE-1, TEST-2/3 fixes were each
re-verified correct with genuine teeth.
