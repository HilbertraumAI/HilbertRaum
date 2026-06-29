# Full audit — HilbertRaum (2026-06-29, follow-up round)

> **Working-paper audit report.** Per the CLAUDE.md doc-lifecycle rule, once these findings are
> dispositioned this file is folded into the relevant topic-doc §§ and `git rm`'d (recoverable in
> history), like the §24/§25/§26 and §27–§34 rounds before it. Until then it is the live ledger.

**Method.** Read-only multi-persona audit run after the post-merge full audit (§27–§34) was complete.
Six specialist personas (security, financial/business-logic, reliability, performance, frontend/product,
testing/maintainability) swept the live source tree in parallel; the three headline findings were
**re-verified firsthand** by the lead (Electron version + preload surface for FE-A; the vault sync-I/O
loop for PERF-1; the `detectCurrency` call chain for FIN-1). Every finding was cross-checked against the
existing §22–§34 ledgers and the carried-forward open-item list so nothing already-fixed or already-accepted
is re-reported as new.

**Baseline at audit time (verified):** `npm test` → **2532 passed / 39 skipped**, `npm run typecheck` clean,
`npm run build` green (per BUILD_STATE). Source hygiene exceptional: **1** `as any`, **1** `TODO`, **0**
`@ts-ignore` across 57 KLOC of non-test source.

---

## 1. Executive summary

HilbertRaum is, by a wide margin, the most thoroughly-audited codebase this team has produced — the crypto,
money parser, sidecar lifecycle, IPC lock guards, and RAG core are all mature and were independently
re-confirmed clean. There is **no Critical and nothing remotely exploitable** (offline by construction).

That said, this round found **three genuinely-new, confirmed, user-impacting bugs that all prior rounds
missed**, plus two carried-forward open items now confirmed still-failing. The common thread is that the
gaps have moved *outward* — away from the heavily-fortified core primitives and into (a) **document/statement
-level orchestration** above the per-row money parser, (b) the **Electron-version platform boundary**, and
(c) **main-thread I/O and DOM scaling**. These are exactly the seams the previous rounds, focused on the
parser internals and consistency-with-the-sibling-path, did not exercise.

**Highest-priority risks**

1. **FIN-1 (High) — wrong-currency financial output.** Document-level currency is "first 3-letter code wins"
   over the *entire* joined text, so a stray `USD`/`CHF` in a payee memo can stamp a whole EUR statement (and
   its VERIFIED total) with the wrong ISO code — silently, because the uniform mislabel never trips the
   mixed-currency guard. The product's core promise is trustworthy figures; this breaks it.
2. **FE-A (High) — a shipped, advertised feature is dead in the packaged app.** Chat drag-and-drop file
   attach reads `File.path`, which Electron removed in v32 (installed: 37.10.3). It silently does nothing,
   with no error, and **no test catches it** because the test mock injects a fake `.path`.
3. **PERF-1 (High) — main-process freeze on every import.** A synchronous whole-file `copyFileSync` +
   `readSync/writeSync` AES-GCM loop blocks the Electron main thread (and all IPC) for the full file size —
   multi-second on a large scanned PDF over USB, and paid *twice* in an encrypted workspace.

**Biggest opportunities**

- A short **financial-correctness phase** (FIN-1..4) closes the last cluster of "confidently-wrong figure"
  paths — the same release-blocking class the §27 round prioritized, now at the statement/document tier.
- A **platform-boundary phase** (FE-A) plus a **main-thread-I/O phase** (PERF-1/PERF-4) removes the two most
  visible real-world UX failures (dead drop, import freeze) with small, standard, well-understood fixes.
- Closing the **two confirmed carried-forward items** — FE-B (F11 provenance honesty) and PERF-2 (PERF-5
  Part B list virtualization) — retires the longest-standing renderer debt.

**Overall health:** strong and release-worthy *once FIN-1 and FE-A are addressed* (FIN-1 because it corrupts
trusted output; FE-A because it ships broken). Everything else is incremental hardening of an already-solid
system.

### Severity rollup

| Sev | Findings |
|---|---|
| **Critical** | *(none — offline by construction)* |
| **High** | FIN-1 wrong-currency totals · FE-A drag-drop dead (Electron 37) · PERF-1 sync-import main-thread freeze · PERF-2 no list virtualization (at scale; = PERF-5 Part B) |
| **Medium** | FIN-2 invoice line-item over-drop · FIN-3 geometry classifier (bare-thousands→date) · FIN-4 memo-date flips doc date order · FE-B F11 provenance honesty (carried-fwd) · FE-C silent drop feedback · PERF-3 `listDocuments` parses full `ocr_json` · PERF-4 text/CSV OOM vs friendly reject · TEST-1 flaky vision idle block · TEST-3 no RAG-quality CI floor · DX-1 `DocTaskManager` god-class |
| **Low / Info** | SEC-1c/SEC-2/SEC-3 (open, accepted) · SEC-4 `extract_to` parse-time validation · REL-1 OCR latch race · REL-2 VisionService teardown race · REL-3 e5 batch re-check · REL-4 shutdown stream-abort ordering · PERF-5 ImagesScreen handler memo · PERF-6 OCR blob · FE-D SourcesDisclosure aria-controls · FE-E WorkspaceGate finishing notice · DX-2 prod test instrumentation · DX-3 oversized screens · DX-4 lock-guard enumeration drift · DX-5 ladder-wiring test · DX-6 settle-window sleeps · misc parser/i18n nits |

---

## 2. Findings

### FIN-1 — Document-level currency is "first 3-letter code wins" → wrong-currency verified totals
- ✅ **REMEDIATED (2026-06-29, Phase 1)** — `money.ts detectDocumentCurrency` (figure-adjacent majority vote) wired into both tool `.run`s; see architecture.md §8.
- **Category:** Financial correctness (currency) · **Severity:** High · **Confidence:** High (reproduced + call-chain verified)
- **Location:** `services/skills/tools/money.ts:21-27` (`detectCurrency`); `tools/bank-statement.ts:464` (`statementCurrency`); `tools/invoice.ts:419` (`documentCurrency`); per-row fallback `bank-statement.ts:178` / `invoice.ts:330` (`detectCurrency(figureRegion) ?? statementCurrency`).
- **Description.** `detectCurrency` returns the **first** allowlisted ISO code found *anywhere* in the text. The BL-2/F3 fix narrowed only the *per-row figure-region* detection; the *statement/document-level* detection — which serves as the per-row fallback when a bare-amount row has no figure-adjacent currency (the de-AT norm) — still scans the whole joined document, memos and headers included.
- **Evidence.** `for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) { if (ISO_CODES.has(m[1])) return m[1] }`. On `"...Verwendungszweck: USD Auslandsentgelt ... Waehrung EUR ... Gehalt 2.500,00 ..."`, `detectCurrency(joined) → "USD"`; the `2.500,00` figure region has no code → falls back to `"USD"`. Every bare-amount row is labeled USD, so `summarizeCashflow` reports a **VERIFIED total in USD**, and the **uniform** mislabel means the mixed-currency guard (fires on >1 distinct currency) never trips. Invoice path inherits it: `header.currency` → net/tax/gross printed in the wrong code.
- **Consequences.** The user sees, trusts, and exports (CSV → accounting software) a verified total/breakdown stamped with the wrong currency. A domestic statement can be silently presented as foreign.
- **Recommended fix.** Derive document/statement currency **figure-adjacently** — majority vote over the figure-region detections of money-bearing rows — instead of `detectCurrency(joined)`. Cheapest: have `extractTransactionRows`/`extractInvoice` aggregate the rows' own figure-region currencies. Bump `BANK_EXTRACTOR_VERSION`/`INVOICE_EXTRACTOR_VERSION` (output changes).
- **Tests needed.** Bare-amount EUR statement + a `USD`/`CHF` token in a memo/header → currency EUR, total EUR; same for `header.currency`; a genuinely foreign statement (code adjacent to amounts) still detected. Characterization-first through the real `extractTransactionRows`/`extractInvoice`.

### FIN-2 — Invoice F1 right-side "uncaptured column" drop over-fires on trailing annotations → deletes valid line items
- ✅ **REMEDIATED (2026-06-29, Phase 1)** — `invoice.ts UNCAPTURED_AMOUNT_AFTER` now requires the whole trailing region to be one money-shaped-but-rejected token; see architecture.md §8.
- **Category:** Extraction recall · **Severity:** Medium · **Confidence:** High (reproduced)
- **Location:** `tools/invoice.ts:169` (`UNCAPTURED_NUMBER_AFTER = /(?:^|\s)[-+(]?\d/`), drop at `:315-317`.
- **Description.** F1 drops an invoice line when *any* digit-bearing token follows the last money match (to catch an uncaptured line-total column). It matches **any** trailing digit, including non-monetary annotations.
- **Evidence.** `"Service 12,50 (Pos. 3)"`, `"Beratung 1.234,56 19% MwSt"`, `"Line 50,00 EUR 2 Stk"` all DROP. Only `Hosting 12,50 500` (true uncaptured total) and clean `50,00` are pinned by tests; these false-drops are uncovered.
- **Consequences.** A real line item is silently removed → `lineItemsSumToNet` under-counts / mismatches; displayed line-item count wrong. The triggering pattern (per-line VAT %, position numbers, trailing qty) is common.
- **Recommended fix.** Restrict the drop to a trailing token that is itself **money-shaped-but-rejected** (a bare integer / single-decimal amount column anchored to end), excluding `%`, `x`, and unit words — not "any digit anywhere after."
- **Tests needed.** The three examples above → kept; `Hosting 12,50 500` → still dropped.

### FIN-3 — Geometry token classifier rejects bare-thousands / Swiss-apostrophe amounts; `2.500` is misclassified as a date
- ✅ **REMEDIATED (2026-06-29, Phase 1)** — `pdf-layout.ts DATE_TOKEN_RE` tightened (year must follow its own dot) so `2.500` is un-date-able; `MONEY_TOKEN_RE` deliberately NOT widened (split-amount safety) — divergence in architecture.md §8.
- **Category:** PDF geometry extraction · **Severity:** Medium (latent; High harm when it fires) · **Confidence:** High (reproduced)
- **Location:** `ingestion/parsers/pdf-layout.ts:43` (`MONEY_TOKEN_RE = /^[-+(]?\d[\d.,]*[.,]\d{2}\)?-?$/`), `:35` (`DATE_TOKEN_RE`), `classifyToken` `:83-94`.
- **Description.** The geometry classifier's money regex requires a 2-digit decimal tail, so it does **not** mirror the shared `MONEY_RE` DECISION-2 grammar (bare grouped thousands + Swiss apostrophe). Its comment claiming it "mirrors the accepted set of the shared `MONEY_RE`" is stale/false post-DECISION-2.
- **Evidence.** `classifyToken("1.000") → text`; `"2.500" → date` (backtracks day=2/month=5/year=00 in `DATE_TOKEN_RE`); `"1'234.56" → text`. Row `07.02. EINKAUF 2.500 1.000,00`: `2.500` taken as a date and dropped → only the balance remains → `reconstructLine` emits `…EINKAUF 1.000,00`; with no trailing bare number the line-parser **F1 guard doesn't fire** → the running **balance is read as the movement amount** (the cardinal confidently-wrong-money harm, via a path F1 doesn't cover).
- **Consequences.** On statements printing round amounts without cents (or apostrophe grouping), the geometry pass drops/mis-reads the amount; on a balance-less listing, D56-R presents an `unverified` sum that is wrong, and the row shows the balance as the amount.
- **Recommended fix.** Widen `pdf-layout.ts` `MONEY_TOKEN_RE` to the shared parser's forms (bare `\d{1,3}([.,']\d{3})+`, `'` grouping) and/or tighten `DATE_TOKEN_RE` so a 3-digit "month" can't backtrack into a date; add a "keep in sync with `MONEY_RE`" comment; bump `BANK_EXTRACTOR_VERSION`.
- **Tests needed.** Geometry fixture rows with `2.500`/`10.000` (no cents) and `1'234.56` → `money`, reconstructed correctly; `<date> X 2.500 1.000,00` → amount 2500, balance 1000.

### FIN-4 — One foreign-format memo date flips the whole document's date order → silent day/month swap on every row
- ✅ **REMEDIATED (2026-06-29, Phase 1)** — `money.ts inferDateOrder` vote scoped by line kind (money line → leading date column; money-less header → any date); divergence (preserves labeled US-invoice dates) in architecture.md §8.
- **Category:** Date parsing · **Severity:** Medium · **Confidence:** Med-High (reproduced; extends BL-N1 residual)
- **Location:** `tools/money.ts:171-181` (`inferDateOrder`), driving `parseDate(token, order)` for every row.
- **Description.** `inferDateOrder` scans the **entire joined text** (incl. descriptions/memos) and flips to month-first on *one* unambiguously-US token with no unambiguously-EU one. de-AT dotted `dd.mm.yyyy` booking dates with day ≤ 12 are ambiguous, so they don't block the flip. The documented BL-N1 residual covers only "a document whose *own* dates are all ambiguous," not **contamination by a foreign-format date inside a memo**.
- **Evidence.** A statement of dotted `05.03.2026`/`07.03.2026`/`11.03.2026` rows plus a `03/15/2026` order-reference in one memo → `inferDateOrder → "mdy"` → `05.03.2026` read as 2026-05-03 (5 Mar → 3 May), etc. All rows parse to *valid* (wrong) dates → none dropped → fully silent; the completeness gate checks balances only.
- **Consequences.** Every booking/value date is day/month-swapped; CSV export and the answer carry corrupted dates. Triggered by ordinary content (a pasted US order date).
- **Recommended fix.** Restrict `inferDateOrder`'s scan to the **leading date column** of transaction rows (reuse `splitLeadingDates`); a memo date must not vote. At minimum require ≥2 corroborating US tokens or weight leading-column dates.
- **Tests needed.** de-AT statement, all-dotted day≤12 booking dates + a `03/15/2026` memo date → order stays `dmy`, dates correct.

> **Financial — checked and CLEAN:** `parseAmount` cent normalization/float precision (T5), `MONEY_RE`
> ReDoS/grouping/both-separator forms, `reconcileBalances`/`assessCompleteness` integer-cent ties &
> mixed-currency=unverified, LLM categorizer amount integrity (enum-constrained; never sees/alters amounts),
> geometry multi-baseline association & the (correctly) disproven money-column model, `stripDateTokens`/
> `splitLeadingDates`/`lastMoneyOnLine`. *Latent note:* `parseAmount("EUR -50,00") → +50` if ever called
> directly (not reachable — `MONEY_RE` always strips the prefix first); add a guard test.

---

### FE-A — Chat drag-and-drop file attach is silently dead in the packaged app (Electron 37 removed `File.path`)
- ✅ **REMEDIATED (2026-06-29, Phase 2)** — preload bridge `window.api.getDroppedFilePath` (wraps `webUtils.getPathForFile`, runs in the sandboxed preload); `pathsFromDrop` calls it instead of the removed `File.path`; tests rewired to the real bridge shape + a preload-surface contract test; real-Electron 37.10.3 availability verified. No new IPC channel. See architecture.md "Renderer robustness" → "Drag-drop intake (Phase 2)".
- **Category:** Frontend / platform boundary · **Severity:** High · **Confidence:** High (verified firsthand)
- **Location:** `renderer/screens/ChatScreen.tsx:1466-1475` (`pathsFromDrop`), used by `onDrop` `:1158-1164`; preload `preload/index.ts` (no `webUtils` shim).
- **Description.** `pathsFromDrop` reads `(files[i] as { path?: string }).path`. Electron removed the non-standard `File.path` in **v32**; the replacement is `webUtils.getPathForFile(file)`, which must be called from the **preload** (not the sandboxed renderer). Installed Electron is **37.10.3** (pin `^37.0.0`); `webUtils`/`getPathForFile` appears **nowhere** in source.
- **Evidence (verified).** `node -e require('electron/package.json').version` → `37.10.3`; `grep -rn webUtils\|getPathForFile src` → no matches; `pathsFromDrop` returns `[]` because `.path` is `undefined`. `tests/renderer/ChatAttach.test.tsx:90-93` fabricates `dataTransfer.files = [{ name, path }]`, injecting a property real Electron 37 doesn't provide → suite green while production fails. The `pathsFromDrop` comment ("Electron exposes `File.path`") is now factually wrong.
- **Consequences.** Dragging a file onto the chat surface does nothing — no import, no pending chip, no error. A core advertised intake path is broken in the shipped product; the paperclip picker (via `pickDocuments`) still works, masking the dead drop.
- **Recommended fix.** Expose `webUtils.getPathForFile` from the preload as e.g. `window.api.getDroppedFilePath(file)`; have `pathsFromDrop` use it (`file.path ?? getPathForFile(file)` only if older Electron must be supported). Fix the test to exercise the real bridge; add a preload-surface contract test.
- **Tests needed.** Renderer test that drops a `File` **without** `.path` and asserts `importDocuments` is still called with a resolved path; contract test that the preload surface includes the resolver.

### FE-B — F11 renderer half still open: `mode:'tree'` answers present whole-doc leaf provenance as if inline-cited, and dump ~1000 uncapped "Sources"
- **Category:** Citations / provenance honesty · **Severity:** Medium-High · **Confidence:** High (carried-forward item, confirmed still failing)
- **Location:** `renderer/chat/SourcesDisclosure.tsx` (whole file), `chat/Transcript.tsx:238-249`; server side `services/rag/index.ts:761-773` (`answerWholeDocFromTree`) + `analysis/coverage.ts:95-118` (`documentLeafProvenance`, uncapped).
- **Description.** A whole-document (`mode:'tree'`) answer returns a persisted `Message` whose `citations` are one entry per reachable **leaf chunk** (up to ~1000, uncapped) — pure provenance, no inline `[Sn]` grounding. `Transcript` renders it through the **same** `SourcesDisclosure` + `CoverageMeter` as a 3-source grounded relevance answer. `SourcesDisclosure` has no `mode`/coverage awareness → renders "Sources (1000)" and, on expand, ~1000 cards, byte-identical to inline-grounded citations. (The `CoverageMeter` *does* differentiate breadth — good — but the Sources list misleads by implication.)
- **Evidence.** `{m.citations && m.citations.length > 0 && (<><SourcesDisclosure citations={m.citations}/><CoverageMeter .../></>)}`; no `chat.sources.wholeDoc` key exists in `en.ts`/`de.ts` → the differentiation was never built. rag-design §14.4 flagged exactly this as the renderer follow-up.
- **Consequences.** A non-technical user reads "Sources (1000)" + a wall of cards as "the model cited 1000 passages" when nothing was shown inline; plus a real jank problem (1000 uncapped cards, no virtualization).
- **Recommended fix.** Thread `coverage.mode` into `SourcesDisclosure`; for tree/extract/whole modes relabel to whole-document provenance (new `chat.sources.wholeDoc` EN+DE keys, "Drawn from the whole document — N sections"), visually mark cards as "sections covered," and cap the rendered list (~24 + "and N more"). Consider capping `documentLeafProvenance` server-side too.
- **Tests needed.** `mode:'tree'` message renders the provenance label (not "Sources (N)") and caps the list; a relevance message still renders "Sources (N)" 1:1.

### FE-C — `onDrop` swallows a drop that yields no usable path with no user feedback
- ✅ **REMEDIATED (2026-06-29, Phase 2)** — `onDrop` now shows a friendly banner (`chat.attach.dropUnsupported`, EN+DE) when a Files-bearing drop resolves to zero importable paths; empty-drop test added. See architecture.md "Renderer robustness" → "Drag-drop intake (Phase 2)".
- **Category:** Forms / error surfacing · **Severity:** Medium · **Confidence:** High
- **Location:** `ChatScreen.tsx:1158-1164` + `:1466-1475`.
- **Description.** `if (paths.length > 0) void attachFiles(paths)` has no `else` — a drop producing zero importable paths (now *always*, per FE-A, but also any browser-origin drag) is indistinguishable from "nothing happened." Contrast the Images screen, which surfaces `multiDrop`/`unsupportedType` banners.
- **Recommended fix.** On a `Files`-bearing drop that resolves to zero paths, show a friendly error (`chat.attach.dropUnsupported`-class). Pairs with the FE-A fix.
- **Tests needed.** Drop with no resolvable path → error banner shown.

### FE-D / FE-E (Low)
- **FE-D — `SourcesDisclosure` toggle lacks `aria-controls`; expanded region unlabeled** (`SourcesDisclosure.tsx:14-23`; same in `Transcript.tsx` SummaryMarker `:317-329` & Thinking `:155-160`). Give the cards an `id` + `aria-controls`/`role="region"`. Inconsistent with the careful a11y elsewhere (ContextMeter, StreamAnnouncer).
- **FE-E — `WorkspaceGate` "finishing" model-verify failure is silent** (`WorkspaceGate.tsx:106-135`). The `catch → finish(next,'chat')` (correctly "never trap the user") means a first-run model-listing failure produces no notice; the user lands on Chat and hits a generic "no model" empty state. Pass a one-shot notice or route to `'models'` when `listModels` *threw*. (Hypothesis — confirm intended UX.)

---

### PERF-1 — Synchronous whole-file copy / encrypt / decrypt blocks the main process on every import
- **Category:** Event-loop blocking · **Severity:** High · **Confidence:** High (verified firsthand)
- **Location:** `ingestion/index.ts:608` (`copyFileSync`), `:603/:623/:631` → `workspace-vault.ts:210-219` (`encryptFile`) & `:268-275` (`decryptFile`).
- **Description.** Plaintext import does `copyFileSync`; encrypted import/re-index stream in 8 MiB chunks (memory bounded — good) but via a **synchronous** `readSync`/`writeSync` + `cipher.update` loop with no `await`/yield. All on the Electron main thread.
- **Evidence (verified).** `while ((bytes = readSync(src, buf, 0, buf.length, null)) > 0) { const ct = cipher.update(...); if (ct.length>0) writeSync(out, ct) }`. Default `maxBytes` = 1 GiB.
- **Consequences.** A large-but-legal document (e.g. a big scanned PDF) on a ~25 MB/s USB drive is multi-second fully-synchronous I/O → UI freeze, IPC stall, embedder sidecar unservable. Encrypted workspaces pay it **twice** per import (encrypt-on-store + decrypt-to-parse) and again on every re-index. Scales with file size (small docs are fine).
- **Recommended fix.** `copyFileSync` → `await fs.promises.copyFile`; convert the vault loop to async handles or `stream.pipeline(createReadStream → cipher → createWriteStream)` (same `MAGIC|iv|tag|ct` frame, but it yields). If too invasive, run encrypt/decrypt on a worker thread.
- **Validate.** Import a ~500 MB file in an encrypted workspace; measure main-thread event-loop lag (`perf_hooks.monitorEventLoopDelay`) before/after — the contiguous multi-second block should disappear.

### PERF-2 — No list virtualization (chat transcript + documents list) = PERF-5 Part B, confirmed still open
- **Category:** Renderer / DOM growth · **Severity:** High at scale · **Confidence:** High
- **Location:** `chat/Transcript.tsx:114`, `screens/DocumentsScreen.tsx:1025`.
- **Description.** Every persisted message / document maps to a live, memoized-but-never-unmounted DOM node; each `DocRow` mounts a Radix `DropdownMenu.Root`, each assistant `MessageBlock` retains a parsed markdown subtree. No virtualization library in deps.
- **Consequences.** DOM + retained markdown ASTs grow linearly with session/library size; hundreds of mounted menu roots at 100× documents; opening a long thread parses every message's markdown synchronously — competing with token generation on CPU-only hardware.
- **Recommended fix.** Window the **documents list** first (near-fixed row height; offline-bundleable `@tanstack/react-virtual`). Transcript windowing (variable height + scroll-to-bottom + find-in-page + StreamAnnouncer) is defensible to keep deferred but should stay the tracked top renderer item, not closed.
- **Validate.** Seed 1000 docs / a 500-turn thread; measure mounted-node count + initial render + scroll-frame timing before/after.

### PERF-3 — `listDocuments` does `SELECT *` and `JSON.parse`s the full `ocr_json` blob per OCR'd doc — only to read a page count
- **Category:** SQLite / main-thread CPU · **Severity:** Medium · **Confidence:** High
- **Location:** `ingestion/index.ts:1371` (`SELECT *`), `:333`→`parseOcr` (`:281-303`), `ocrInfoOf` (`:307-315`).
- **Description.** DB-8 projected columns on the single-doc getters but the **list** path still pulls `ocr_json` for every row and fully `JSON.parse`s it (reconstructing `pages[]` *with* every page's text) only to keep `pages.length`/`languages`/`engineId`/`createdAt`.
- **Consequences.** A library with many OCR'd PDFs makes every `listDocuments` (each documents-screen mount, import-completion, collection/lifecycle change) read + parse megabytes of OCR text on the main thread, allocate large arrays, discard them → synchronous spike + GC pressure on the hottest list path.
- **Recommended fix.** Project the narrow column set in `listDocuments` + a metadata-only OCR read (or an `ocr_meta_json` sidecar column / metadata-only `parseOcr` mode). Cleanest: move OCR pages to a child table (also fixes PERF-6).
- **Validate.** 50 × 2000-page scans present; time `listDocuments` before/after projecting away `ocr_json`.

### PERF-4 — Text/CSV parsers read the whole file into one JS string; the 1 GiB cap exceeds V8's string limit → OOM crash instead of friendly reject
- **Category:** Memory · **Severity:** Medium · **Confidence:** Med-High
- **Location:** `parsers/txt.ts:10`, `parsers/markdown.ts:24-25`, `parsers/csv.ts:24,31,39-65`.
- **Description.** Reads are async (good) but materialize the whole file as one UTF-16 string, then derive more full copies (`raw.split`, `Papa.parse` → row array → rebuilt `lines.join`). `maxChunks=1000` caps output, not these intermediates. A file approaching `maxBytes` (1 GiB) exceeds V8's ~512 MB string/heap limit → hard crash, not the friendly `fileTooLarge`.
- **Recommended fix.** Give text/CSV formats a string-safe effective byte cap (tens of MB) so oversize files hit the friendly reject; better, stream-parse (line reader; papaparse `step`).
- **Validate.** Feed a 300 MB `.txt`/`.csv`; confirm crash→reject and bounded heap after.

### PERF-5 / PERF-6 (Low)
- **PERF-5 — `AnswerThread` memo defeated by unstable handler props** (`images/AnswerThread.tsx:39` memo; `screens/ImagesScreen.tsx:390-395` passes fresh closures each render while the screen re-renders per vision flush). Wrap `onCopy`/`onTryAgain`/`onStop` in `useEventCallback`/`useCallback` (as ChatScreen/DocumentsScreen already do). Image sessions are short → Low-Med.
- **PERF-6 — OCR pages stored as one `ocr_json` blob** stringified/parsed whole (`ingestion/index.ts:1198/:1217`; bounded by `pdfMaxPages`=5000). Move to a per-page child table (also resolves PERF-3's root cause). Low.

> **Performance — checked and CLEAN:** resident vector cache (PERF-1/F12), RRF fusion + FTS sanitizer (no
> N+1), chunker (linear, 1000-cap), every hot SQLite predicate indexed, no remaining ReDoS, PDF/image/audio
> parsers + OCR rasterizer bounds, renderer memoization (`MessageBlock`/`DocRow`/`ConvRow`/`AssistantMarkdown`)
> + streaming plain-text-then-markdown-once (PERF-6 wave). *Hypotheses (not confirmed):* DOCX inflate+walk at
> the `docxMaxInflatedBytes`=1 GiB ceiling; `ImageHistory` per-row `Intl` churn.

---

### Security findings (all Low/Info; carried items confirmed open, accurately scoped)
- **SEC-1 code half (Low, open/accepted).** Unlock IPC (`registerWorkspaceIpc.ts:56`) has no attempt-counter/rate-limit; only an 8-char floor (`:24`), no strength meter. Correctly an accepted residual — against the modeled lost/stolen-drive attacker the at-rest Argon2id+AES-GCM is the binding mitigation; a UI rate-limit doesn't bind an offline cracker. Crypto itself confirmed clean (fresh 12-byte IV/call, KDF-bounds vs a tampered descriptor, `timingSafeEqual`, wrong key never touches the DB).
- **SEC-2 (Low, open).** `previewSkillPackage` stages validated content under shared OS `tmpdir()` (`installer.ts:549`, `finally rmSync :605`) — fully path/symlink/ext/size-validated before write, not secret; trust-zone-consistency nit (stage under `userSkillsDir`).
- **SEC-3 (Info, open).** Dialog-opener IPCs mint capability tokens pre-unlock but every **consuming** handler is `requireUnlocked()`-gated → inert. Consistency gap, not exploitable.
- **SEC-4 (Low/Info, NEW) — `runtime-sources.yaml` `extract_to` not `..`-validated at parse time.** `shared/runtime-sources.ts:115-135` accepts any non-empty `extract_to`, while the sibling OCR `dest` field in the *same file* (`:189`) rejects `..`. `model-manifests/` is user-writable on the removable drive. Fully contained today by `resolveWithinRoot` (`assets.ts:262`, throws on escape; `commercial-drive.ts:374` documents the reliance), so it's a latent single-point-of-failure footgun, not a vuln. Fix: reject `..` (and absolute/drive-letter) at validation time, mirroring the OCR field. *(Separately on record, not re-reported: the writable-drive `tar -xf` member-path + attacker-controls-both-url-and-sha trade-off is the documented §22-M2 / audit-2026-06-14 residual.)*

> **Security — checked and CLEAN:** crypto/vault, download/SSRF (per-hop re-validation incl. the F15 mapped-IPv6
> closure, redirect cap, always-bounded size caps, verify-before-rename), binary re-hash-before-spawn, IPC
> `requireUnlocked()` coverage + untrusted-boundary coercion + picker capability tokens + drag-drop symlink
> reject, skills import (dependency-free zip reader, per-member validation, SEC-1 `source==='app'` tool gate
> enforced twice), audit-log PII discipline, the offline guarantee (only network sink is the gated/validated
> `downloadToFile`), and the Electron baseline (contextIsolation/sandbox/CSP/deny-by-default nav+permission).

### Reliability findings (all Low/latent; mirror already-fixed classes)
- **REL-5 (carried, open) — VERDICT: keep deferred, downgrade wording.** Confirmed **architecturally non-reachable**: exactly one live synchronous `DatabaseSync` connection per session (`db.ts:644`; others are transient open→seed→checkpoint→close), and all 15–20 `BEGIN…COMMIT` bodies are synchronous (the slow `await embed/generate` sits *outside* the txn — verified at `ingestion/index.ts:714`, `skills/run.ts:231`, `tree-build.ts`, etc.). `BEGIN IMMEDIATE` would be a no-op without a second writer. **Recommend the §26 note be strengthened to "non-reachable while the single-`DatabaseSync` architecture holds; promote only if a second DB connection (e.g. a worker-thread reader) is introduced."**
- **REL-2 (Low, strongest new) — `VisionService.stop()` defeated by a `run()` rebuilding the runtime during teardown.** `run()` does `this.runtime ??= createRuntime(status)` *after* an `await getStatus()`; a `stop()` (lock/quit) interleaving that await leaves the resumed `run()` to spawn a fresh ~4.6 GB vision sidecar **after** teardown decided everything was down. Unlike embedder/reranker (F19), `VisionService` has no orchestrator-level `tearingDown` latch. Fix: add the F19 `tearingDown` latch, set at top of `stop()`, re-checked in `run()` after the `getStatus()` await. (`vision/index.ts:111-112` vs `:187-203`.)
- **REL-1 (Low) — OCR worker init latch nulled mid-flight.** `terminateWorker()` nulls `this.starting` even if its init promise is still pending (`ocr/tesseract.ts:111-139` vs `:203-215`); a timeout/`stop()` not ordered by `this.chain` can transiently spawn a second WASM worker / reject an awaiting recognition. Bounded/self-healing. Fix: only null `this.starting` when it still equals the torn-down promise, or route terminate through `this.chain`.
- **REL-3 (Low) — `e5.embed()` doesn't re-check `stopped`/`tearingDown` between batches** (`embeddings/e5.ts:216-271`); a suspend mid-ingestion surfaces as a confusing "not started" count error rather than a clean cancel. Fix: re-check per batch, or feed the ingestion `AbortController` into `embed(opts.signal)`.
- **REL-4 (Low) — quit-path `shutdown()` doesn't abort in-flight streams before `runtime.stop()`** (`main/index.ts:476-508`), unlike the lock path (`registerWorkspaceIpc.ts:224-229`); a partial reply in flight at quit is lost rather than persisted-as-partial. Mirror the lock ordering or document the divergence.

> **Reliability — checked and ROBUST:** `LlamaServer` single-flight start / bind-race retry / SIGTERM→SIGKILL
> gating / stderr drain, GPU crash auto-fallback (re-entrancy + re-arm), `RuntimeManager` op-queue, reranker/
> embedder F19 latch, `VisionRuntime` idle interlock, whisper watchdog/escalation/shred, tesseract per-page
> timeout, `combineSignals` timer/listener cleanup, chat regenerate delete-after-slot + partial-on-abort,
> transactional `deleteConversation`, all `BEGIN` sites, `probeGpuDevices`.

### Testing & maintainability findings
- **TEST-1 (Med) — flaky real-timer vision idle-teardown block** (`tests/integration/vision-runtime.test.ts:195-265`) races real `setTimeout`s against tiny `idleTimeoutMs` in **both** directions (`sleep(15)` asserts not-yet-torn-down; `sleep(60)` asserts torn-down). A deterministic fake-clock twin already exists below it (`:268+`). Retire the real-timer block (the known T6/T7 "real-timer copies left" item).
- **TEST-3 (Med) — no CI floor on end-to-end RAG retrieval quality.** The scorer logic is CI-gated (`tests/eval/score.test.ts`) and the skill-trigger precision bar is a live gate, but actual retrieval→answer quality (EM/hallucination/citation over the corpus) is asserted only in env-gated manual suites. A regression in chunking/embedding-prefix/reranking/`ragMinSimilarity` passes `npm test` green. Add a **model-free synthetic-corpus** CI floor (mock embedder ranks the known-correct chunk first; assert the pipeline returns its `chunk_id`/citation) — guards the plumbing without a real model.
- **DX-1 (Med) — `DocTaskManager` god-class** (`doctasks/manager.ts`, 1758 lines, 8 unrelated task domains + queue/pump/arbiter). Extract each `run<Kind>` into a per-kind handler keyed by a registry; manager keeps only orchestration. Largest structural debt.
- **DX-3 (Low) — oversized screens** (`DocumentsScreen.tsx` 2089, `ChatScreen.tsx` 1490). Split `DocRow`/`SectionRail`/`PreviewModal` into sibling files (tests already import them as units); lift formatters to `documents/format.ts`.
- **DX-4 (Low-Med) — IPC lock-guard coverage relies on hand-maintained exemption/module sets** (`tests/integration/ipc-lock-coverage.test.ts:71-102`). A new `register*Ipc` module simply isn't enumerated → its handlers go unchecked. Add a meta-assertion: union(`MODULES`, "covered elsewhere") == all `register*Ipc` exports discovered by glob, failing if a new module appears uncovered.
- **DX-2 (Low) — `__docRowRenderCounts` test instrumentation shipped in production** (`DocumentsScreen.tsx:85`, exported Map bumped every `DocRow` render). Guard behind `import.meta.env.DEV` or inject an `onRender` callback.
- **DX-5 (Low) — `runtime-ladder` crash-recovery tested by hand-invoking `onUnexpectedExit`** (`tests/unit/runtime-ladder.test.ts:206,213`) — proves handler logic but not that the real sidecar wires `'exit'` → callback. Add one integration test that emits a real `'exit'` and asserts recovery fires.
- **DX-6 (Low) — settle-window real sleeps** (`reranker.test.ts:447`, `e5-embedder.test.ts:536`, `doctasks.test.ts:314`): "assert nothing happened after a fixed delay" — robust today but un-teeth-checkable and waste wall-clock. Prefer deterministic queue-drain / fake clock.
- **Minor (Info) — `act(...)` warning** in `tests/renderer/ChatCompaction.test.tsx` (state update outside `act`, `ChatScreen.tsx:46`). Wrap the flushing update.

> **Testing — checked and SOLID:** type hygiene (2 `as any` both in comments, 0 ts-ignore, no `.only`/`xit`),
> integration on real `node:sqlite`+FS+IPC registration (mock line drawn at the runtime/embedder seam),
> crypto/vault failure-path coverage (wrong key/bit-flip/truncation/tampered-descriptor/zeroing/shred), 88-case
> money/date suite incl. ReDoS-linearity, `FullSuiteGuard` false-green protection, deterministic SIGKILL-escalation.

---

## 3. Documentation audit

Docs are in unusually good shape — Phase 7 of the post-merge round (§33) and a subsequent docs-audit cycle
reconciled most contradictions. Remaining items, all tied to the findings above:

- **rag-design §14.4 (F11)** documents the tree-mode provenance distinction but the renderer never implemented
  it (FE-B). When FE-B lands, update §14.4 from "renderer differentiation = Phase 8 follow-up" to as-built.
- **`money.ts` `detectCurrency` doc-comment** describes per-row figure-region scoping but doesn't note that the
  **document-level** call still scans whole text (FIN-1). Update when fixed; record in known-limitations until then.
- **`pdf-layout.ts:43` comment** "Mirrors the accepted set of the shared `MONEY_RE`" is **stale/false**
  post-DECISION-2 (FIN-3) — actively misleading a future agent. Correct it (and add a keep-in-sync note).
- **`ChatScreen.tsx:1462-1465` `pathsFromDrop` comment** "Electron exposes `File.path`" is **factually wrong**
  on Electron ≥32 (FE-A). Correct alongside the fix.
- **known-limitations.md** — add: document-level currency contamination (FIN-1), invoice trailing-annotation
  over-drop (FIN-2), geometry no-cents/apostrophe amounts (FIN-3), memo-date order contamination (FIN-4) until
  fixed; and the text/CSV string-cap behavior (PERF-4).
- **architecture.md §26** — strengthen the REL-5 note to state the single-connection precondition explicitly.

No newly-discovered doc that contradicts shipped behavior beyond the four stale code-comments above.

## 4. Testing audit (summary)

**Strengths:** behavior-first integration (real DB/FS/IPC), teeth-checked security/reliability seams, the
`FullSuiteGuard`, near-zero type escapes, the live skill-trigger precision gate. **Weaknesses / gaps:**
(1) no automated end-to-end RAG-quality floor (TEST-3) — the one material coverage gap; (2) the flaky vision
real-timer block (TEST-1); (3) lock-guard enumeration drift (DX-4); (4) a few hand-invoked-callback wiring
tests (DX-5) and settle-window sleeps (DX-6); (5) the FE-A test mock that injects a property production lacks —
a **false-green that hid a shipped bug** (the most important test lesson of this round: mocks that fabricate
platform APIs can mask real regressions). **Avoid over-mocking guidance:** keep drawing the mock line at the
model-runtime/embedder boundary; for platform APIs (`webUtils`, `File.path`) prefer a thin real preload bridge
the test drives over a fabricated property.

## 5. Performance audit (summary)

The vector/RAG/SQLite core is efficient and was confirmed clean. The real costs are **main-thread I/O**
(PERF-1, every import) and **unbounded DOM/parse growth** (PERF-2 lists, PERF-3 `ocr_json`, PERF-4 string
caps). Validate each with the measurement noted per finding (event-loop-delay probe for PERF-1; mounted-node
+ render-timing for PERF-2; per-call time + allocation for PERF-3; bounded-heap for PERF-4).

---

## 6. Phased remediation plan

Each phase is independent and executable in a fresh session. Every phase ends with: tests green, build +
typecheck clean, affected `docs/` + `BUILD_STATE.md` updated, a per-finding ledger row folded into the
relevant arch §, and a commit referencing the phase (per the CLAUDE.md per-phase ritual). Behavioral fixes
are **characterization-first then test-first** (pin current behavior → assert correct post-fix → red→green),
and **teeth-checked** where a guard is added.

### Phase 1 — Financial correctness (FIN-1..4) — **release-blocking class, do first** — ✅ REMEDIATED 2026-06-29
> **Done on branch `audit-followup-phase1-financial`.** All four fixed characterization-first/test-first
> through the real entry points + teeth-checked; suite **2547 passed / 39 skipped**, typecheck + build green.
> `BANK_EXTRACTOR_VERSION` 2→3, `INVOICE_EXTRACTOR_VERSION` 1→2 (the A9/F5 reuse gate re-extracts older rows).
> Durable record: **architecture.md §8 "Financial correctness (full-audit-2026-06-29 follow-up, Phase 1)"**.
> **Two divergences recorded there** (both the mechanically-correct call): FIN-3 fixes only `DATE_TOKEN_RE`
> (NOT widening `MONEY_TOKEN_RE`, which would regress the M3 split-amount safety boundary); FIN-4 scopes the
> date-order vote by line KIND (money line → leading column only; money-less header → any date) because the
> pure "leading column" rule broke labeled US-invoice dates.
- **Goal:** eliminate the remaining "confidently-wrong figure / wrong currency / wrong date" paths at the
  statement/document tier.
- **Scope/files:** `money.ts` (`detectCurrency` usage, `inferDateOrder`), `bank-statement.ts`, `invoice.ts`,
  `ingestion/parsers/pdf-layout.ts`. Bump `BANK_EXTRACTOR_VERSION` / `INVOICE_EXTRACTOR_VERSION`.
- **Steps:** (FIN-1) derive document/statement currency by majority vote over rows' figure-region detections;
  (FIN-2) tighten the invoice right-drop to a money-shaped-but-rejected trailing token only; (FIN-3) widen
  `pdf-layout.ts` `MONEY_TOKEN_RE` to the shared grammar + fix the date backtrack + sync comment; (FIN-4)
  restrict `inferDateOrder` to leading date columns.
- **Tests:** the per-finding characterization tests above, all through the real `extractTransactionRows`/
  `extractInvoice`/`reconstructLine` entry points (TEST-N2 whole-string discipline). Re-confirm the normal
  2-figure de-AT row and the HVB no-balance geometry case stay byte-identical/green.
- **Docs:** arch §8 records; known-limitations entries removed as each is fixed; correct the `pdf-layout.ts`
  stale comment.
- **Acceptance:** wrong-currency/​wrong-date/​dropped-line cases corrected; no regression in the pinned suites;
  extractor-version bump documented (old workspaces re-extract on next analysis).
- **Risks/rollback:** parsing changes can regress edge formats — mitigated by characterization-first + the
  existing gold fixtures. Version bump is the rollback boundary.

### Phase 2 — Electron-37 drag-drop regression (FE-A + FE-C) — **shipped feature dead, do early** — ✅ REMEDIATED 2026-06-29
> **Done on branch `audit-followup-phase2-dragdrop`.** Restored chat drag-drop attach + the
> zero-path feedback; suite **2551 passed / 39 skipped** (+4), typecheck + build green.
> FE-A: a preload bridge `window.api.getDroppedFilePath` wraps `webUtils.getPathForFile` (the
> sandboxed-preload replacement for the removed `File.path`); `pathsFromDrop` calls it. **No new
> IPC channel** — webUtils is synchronous/in-process in the preload, so the resolver is a plain
> bridge function (nothing added to `shared/ipc.ts`; renderer typed via `PreloadApi`). FE-C: a
> friendly `chat.attach.dropUnsupported` banner (EN+DE) on a Files-bearing drop that yields no
> path. Tests rewired off the fabricated `File.path` to the real bridge shape + a preload-surface
> contract test, all teeth-checked (RED→GREEN verified). Real-Electron 37.10.3 leg confirmed
> (bridge exposes the resolver in the actual renderer; `webUtils.getPathForFile` callable in the
> sandboxed preload). Durable record: architecture.md "Renderer robustness" → "Drag-drop intake
> (full-audit-2026-06-29 follow-up, Phase 2 — FE-A / FE-C)". The **Images** drop reads File bytes,
> not `File.path` — unaffected, confirmed.
- **Goal:** restore chat drag-drop attach; surface feedback on an unusable drop.
- **Scope/files:** `preload/index.ts` (expose `webUtils.getPathForFile`), `shared/ipc.ts` (preload surface
  type), `renderer/screens/ChatScreen.tsx` (`pathsFromDrop`, `onDrop` else-branch + stale comment),
  `tests/renderer/ChatAttach.test.tsx` (drive the real bridge).
- **Steps:** add `getDroppedFilePath` to the preload bridge; `pathsFromDrop` uses it (with `file.path ??`
  fallback only if older Electron supported); add the empty-drop error; fix the test mock + add a
  preload-surface contract test.
- **Tests:** drop a `File` without `.path` → `importDocuments` still called; empty-drop → error banner;
  preload surface includes the resolver.
- **Docs:** none user-facing; correct the code comment.
- **Acceptance:** drag-drop attach works in a real packaged build (manual eyeball per the electron-eyeball
  recipe); the new test reds on the old `File.path` code.
- **Risks:** must run `getPathForFile` in the preload (not the sandboxed renderer) — low risk, standard pattern.

### Phase 3 — Main-thread import I/O + parser memory caps (PERF-1 + PERF-4)
- **Goal:** remove the synchronous import freeze; turn oversize text/CSV into a friendly reject.
- **Scope/files:** `workspace-vault.ts` (`encryptFile`/`decryptFile`), `ingestion/index.ts` (`copyFileSync`),
  `parsers/{txt,markdown,csv}.ts`, `ingestion/limits.ts`.
- **Steps:** `copyFileSync` → async `copyFile`; convert the vault loop to `stream.pipeline` (same on-disk
  frame); add a string-safe effective byte cap for text/CSV (or stream-parse).
- **Tests:** event-loop-lag probe around a large encrypted import (no multi-second block); oversize `.txt`/`.csv`
  → friendly `fileTooLarge`, not crash; round-trip encrypt→decrypt byte-identical (existing vault tests must stay green).
- **Docs:** known-limitations (text/CSV cap); arch perf record.
- **Acceptance:** no contiguous main-thread block > a small threshold during a 500 MB import; oversize text rejects.
- **Risks:** the vault frame must stay byte-identical (the streaming crypto already targets the exact format) —
  pin with the existing round-trip tests + a cross-read test (old sync-written file decrypts with the new path).

### Phase 4 — Documents-list scale (PERF-3 + PERF-2 documents-list + PERF-6)
- **Goal:** stop parsing `ocr_json` on the list path; window the documents list.
- **Scope/files:** `ingestion/index.ts` (`listDocuments` projection + metadata-only OCR read; optional OCR
  child table), `DocumentsScreen.tsx` (virtualize `visibleDocs`), `package.json` (offline-bundle a virt lib).
- **Steps:** project the narrow column set + cheap OCR-metadata read; add `@tanstack/react-virtual` windowing
  to the documents list (fixed-ish row height); optionally migrate OCR pages to a child table.
- **Tests:** `listDocuments` no longer reads `ocr_json` (assert the prepared SQL / spy); virtualized list renders
  a bounded node count at 1000 docs; existing DocumentsScreen behavior/memo tests stay green.
- **Docs:** arch perf record (DB projection + windowing); PERF-5 Part B ledger updated (documents-list done,
  transcript still tracked).
- **Acceptance:** mounted-node count bounded at scale; `listDocuments` allocation/time drops sharply.
- **Risks:** virtualization touches scroll/find/a11y — keep it to the simpler documents list; do NOT do the
  transcript here.

### Phase 5 — RAG provenance honesty + Sources a11y (FE-B / F11 + FE-D)
- **Goal:** stop presenting whole-document leaf provenance as inline citations; cap the list; fix disclosure a11y.
- **Scope/files:** `chat/SourcesDisclosure.tsx` (+ `mode` prop), `chat/Transcript.tsx` (thread `coverage.mode`),
  `shared/i18n/{en,de}.ts` (new `chat.sources.wholeDoc` keys), optionally `coverage.ts` (server-side cap).
- **Steps:** thread `coverage.mode`; relabel tree/extract/whole modes to whole-document provenance + cap rendered
  cards (~24 + "and N more"); add `aria-controls`/`role="region"` to the disclosure (and SummaryMarker/Thinking).
- **Tests:** tree-mode message renders the provenance label + capped list; relevance message renders "Sources (N)"
  1:1; `aria-controls` resolves when expanded.
- **Docs:** rag-design §14.4 → as-built; design-guidelines a11y note.
- **Acceptance:** the honesty distinction is visible and the 1000-card jank is gone.
- **Risks:** i18n key parity is typecheck-enforced (add EN+DE together).

### Phase 6 — Reliability hardening (REL-2 vision latch, REL-1 OCR latch, REL-3 e5 batch, REL-4 shutdown order)
- **Goal:** close the four latent concurrency/teardown gaps, mirroring the F19 pattern already proven elsewhere.
- **Scope/files:** `vision/index.ts`, `ocr/tesseract.ts`, `embeddings/e5.ts`, `main/index.ts`.
- **Steps:** add a `tearingDown` latch to `VisionService` (re-checked after the `getStatus()` await); fix the OCR
  init-latch null; re-check `stopped` per embed batch (or plumb the abort signal); abort in-flight streams before
  `runtime.stop()` in `shutdown()`.
- **Tests:** deterministic gated-exit interleave tests (parked `getStatus`/init/embed → stop → assert no new
  child / clean cancel), each teeth-checked (neuter the latch → resurrection reds).
- **Docs:** arch GPU §5.5c / Image-understanding §5 / shutdown record.
- **Acceptance:** the four interleavings can't spawn/retain a sidecar past teardown; teeth-checks pass.
- **Risks:** latent today — keep behavior-preserving; the teeth-checks are the guard.

### Phase 7 — Test-suite robustness (TEST-1, TEST-3, DX-4, DX-2, DX-5, DX-6) — **test-only**
- **Goal:** retire the flaky vision block; add the model-free RAG-pipeline CI floor; make lock-guard enumeration
  self-checking; remove the prod test instrumentation; pin the ladder exit wiring; de-sleep settle windows.
- **Scope/files:** `tests/integration/vision-runtime.test.ts`, a new `tests/integration/rag-pipeline-floor.test.ts`,
  `tests/integration/ipc-lock-coverage.test.ts`, `DocumentsScreen.tsx:85` (DEV-guard), `tests/unit/runtime-ladder.test.ts`,
  the three settle-window tests.
- **Tests/Acceptance:** suite stays green + stable across repeated runs; the new RAG floor reds on a deliberately
  mis-wired pipeline; the lock-guard meta-assertion reds when a new `register*Ipc` is added uncovered.
- **Docs:** arch test-enforcement record.
- **Risks:** none to production (test-only) beyond the one DEV-guard in `DocumentsScreen`.

### Phase 8 — Maintainability + security hardening + docs close-out (DX-1, DX-3, SEC-4, FE-E, REL-5 note, doc fixes)
- **Goal:** structural debt + the small security hardening + accepted-residual dispositions + retire this report.
- **Scope/files:** `doctasks/manager.ts` (split per-kind handlers), `DocumentsScreen.tsx`/`ChatScreen.tsx`
  (extract sub-components), `shared/runtime-sources.ts` (`extract_to` `..` reject), `WorkspaceGate.tsx` (finishing
  notice), arch §26 (REL-5 wording), the four stale comments, and fold this report into the arch §§.
- **Tests:** behavior-preserving refactors pinned by the existing per-component tests; a `runtime-sources` validation
  test rejecting `../../escape` (+ `..\\` Windows form).
- **Acceptance:** no behavior change from the refactors; SEC-4 validated; SEC-1c/SEC-2/SEC-3 re-affirmed as accepted
  residuals; report `git rm`'d with its ledger folded into arch.
- **Risks:** the `DocTaskManager` split is the largest blast radius — do it last, behind the full doctasks suite.

## 7. Recommended execution order & dependencies

1. **Phase 1 (Financial)** — first; it corrupts trusted output, the product's core promise, and is the same
   release-blocking class prior rounds prioritized. Independent.
2. **Phase 2 (FE-A drag-drop)** — next; a shipped feature is dead, the fix is small/isolated, no dependencies.
3. **Phase 3 (PERF-1 import I/O)** — the most visible everyday UX failure; independent.
4. **Phases 4, 5, 6, 7** — independent of each other; schedule by capacity. Phase 5 depends on nothing but pairs
   conceptually with the F11 doc-note; Phase 6 is pure latent-hardening; Phase 7 is test-only and safe anytime.
5. **Phase 8 (maintainability + close-out)** — last; the `DocTaskManager` refactor wants a quiet tree, and the
   report retirement should follow once Phases 1–7 dispositions are recorded.

No phase blocks another except by shared-file contention (Phases 1 and the parser docs; Phases 2/5 both touch
ChatScreen/Transcript — sequence them if run by different sessions). Each is sized for a single fresh-context
session.
