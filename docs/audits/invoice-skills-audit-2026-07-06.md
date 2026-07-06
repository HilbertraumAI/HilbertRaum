# Invoice skills & tools audit — 2026-07-06

**Scope:** the invoice skill/tool surface — `tools/invoice.ts`, `tools/money.ts` (shared with bank-statement), `analysis/invoice.ts`, `invoice-run.ts`, `tool-registry.ts`, `tool-runs.ts`, `run.ts` seams, `app-skills/invoice/SKILL.md`, and the invoice-relevant parts of `docs/architecture.md`, `docs/known-limitations.md`, `docs/troubleshooting.md`, and i18n.

**Method:** three parallel audit passes (tool/parser code · analysis pipeline & run lifecycle · docs-vs-code consistency), findings cross-checked against the prior-round ledgers (architecture.md §8/§24/§26/§27/§29/§34/§40/§42) so already-fixed or explicitly-deferred items are **not** re-reported. Regex findings were verified by executing the live `MONEY_RE`/`parseAmount` source. The two HIGH findings and the staleness/purge call graph were independently re-verified during synthesis.

**Verified-clean (no finding):** §27 (F1/F3/F6/F8), §29 (F5 reuse/replace/staleness machinery *as designed*), §26 BL-1 trailing-minus, §42 P1–P4 records all match the code; `INVOICE_EXTRACTOR_VERSION = 11` history consistent; all 36 `skills.invoiceAnalysis.*` + 5 tool-label + 4 run-outcome i18n keys have EN/DE parity; SKILL.md `allowedTools` exactly matches the registry; documented residuals (spaced *trailing* minus, fused space-groups, `USt`-not-in-`TAX_LABELS` known-limitations note, ~150-row cap, glyph-soup thresholds) are accurate.

**Severity summary:** 2 HIGH · 10 MEDIUM · 12 LOW (incl. consolidated test-gap items).

Numbering: **T-*n*** = tool/parser code, **P-*n*** = pipeline/lifecycle, **D-*n*** = docs.

---

## HIGH

### T-1 — Spaced leading dash before a figure reads as a negative sign — dash-as-separator layouts flip sign

- **Where:** `apps/desktop/src/main/services/skills/tools/money.ts:160-161` (`MONEY_RE`), `:185` (`parseAmount`), `:660` (`lastCurrencyAdjacentInteger` sign rebuild).
- **Failure scenario:** `Beratung – 1.500,00 EUR` (Word autocorrects ` - ` to en dash; `normalizeExtractionText` maps U+2013 → `-`) → `MONEY_RE` matches `"- 1.500,00"` → `parseAmount` → **−1500** `lineTotal`. Plain ASCII too: `Gesamtbetrag - 914,00 EUR` → `grossTotal = −914`; on the shared bank path `GUTSCHRIFT - 34,39` reads a **credit as −34.39**. Verified by executing the regex (match `['- 1.500,00', 9]`, parse `-1500`).
- **Evidence:** `MONEY_RE = /(?<!\d)[-+(]?\s{0,4}(?:…)/g` — the leading sign class tolerates up to 4 spaces before the magnitude (the doc comment at `:153` acknowledges "the leading gap is bounded to 4 spaces" — bounded for ReDoS, but semantically still sign-theft). BL-1 space-disambiguated the **trailing** side only. The geometry path deliberately disagrees: `pdf-layout.test.ts:570` pins `'14.01.2025 LASTSCHRIFT - 3,99'` as **positive** ("the far dash is not read as a sign") while the plain path signs it negative — the two extraction paths now diverge on the same text.
- **Fix:** mirror BL-1 on the leading side — a leading `-` signs only when **glued** to the digit/paren (`-(?=[\d(])`), keeping `\s{0,4}` only after `(`. Apply the same to `lastCurrencyAdjacentInteger`'s `const lead = /[-(]\s*$/.exec(before)` (`Gesamt - 914 EUR` currently rebuilds `-914`). Test gap: the R1 suite covers only **glued** en-dash signs (`skills-bank-statement-tool.test.ts:1639`); no test covers a spaced leading dash on the plain path.

### P-1 — Staleness gate is extractor-version-only: re-index / OCR re-ingest keeps serving the pre-change extraction; the glyph-soup refusal tells the user to run OCR and then still refuses forever

- **Where:** `apps/desktop/src/main/services/skills/invoice-run.ts:127-133` (`isInvoiceStale`), `analysis/invoice.ts:640-641` (reuse gate), `services/ingestion/index.ts:750-761` (re-index teardown) vs `:1519-1529` (`purgeSkillDataForDocument` called only from the delete path — verified by call-graph grep).
- **Failure scenario:**
  1. Scanned PDF invoice imports as glyph soup → persisted `text_quality='suspect'`, geometry retry also soup → promoted `'suspect-confirmed'` → handler refuses with `skills.invoiceAnalysis.unreadableLayout`, whose copy instructs *"If it's a scan, run OCR (text recognition) on it first"* (`shared/i18n/en.ts:770-774`).
  2. User runs OCR; re-ingest deletes chunks/embeddings/tree_nodes — **but not the invoice rows**. The extraction input genuinely changed.
  3. Next question: `latestInvoiceId` finds the old row, `isInvoiceStale` returns false (version matches), the handler **reuses** the soup extraction; `'suspect-confirmed'` is final → the *same* refusal, forever. The user followed the app's own instruction and nothing changed.
- The non-soup variant is quieter but worse: a document whose text layer changed silently keeps answering with figures extracted from the **old** content — results attributed to the wrong document version. The bank path has the identical stale-figures gap. §29's "extraction is deterministic, so reusing avoids a duplicate" only holds while the *input* is fixed; re-index breaks that premise and the record never addresses it.
- **Evidence:**
  ```ts
  // invoice-run.ts:132 — version is the ONLY staleness signal
  return row.v == null || row.v !== INVOICE_EXTRACTOR_VERSION
  // ingestion/index.ts:752-755 — re-index teardown, no purgeSkillDataForDocument
  db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(documentId)
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
  ```
- **Fix:** on the re-index/OCR-re-ingest path, call `purgeSkillDataForDocument(db, id)` in the same teardown transaction (simplest — next question re-extracts), or persist a content fingerprint (e.g. the `fully_chunked` indexed-at timestamp) on the extraction row and fold `fingerprint !== documents.fully_chunked` into `isInvoiceStale`/`isBankStatementStale`. Test gap: no test re-indexes a document between two analysis questions.

---

## MEDIUM

### T-2 — Combined one-line totals row assigns the LAST figure to the FIRST matched label

- **Where:** `tools/invoice.ts:613-651` (`applyTotals`), `:477-481` (`lastMoney`).
- **Failure scenario:** `Netto 1.000,00 MwSt 200,00 Brutto 1.200,00` (a 3-column totals block flattened to one segment) → `netto` matches, `isFillerOnly(...)` is true (`mwst`/`brutto` are `TOTALS_FILLER`) → `totalsMoney` takes the **last** token → `netTotal = 1200`; tax/gross stay unset; `lineItemsSumToNet` falsely mismatches. Regex behavior verified.
- **Fix:** when the remainder after the matched label contains another boundary-matched totals label, split the line at each label and read the figure nearest after its own label — or refuse the line (drop-don't-guess). No test covers a multi-label totals line.

### T-3 — A 2-dp tax RATE is read as the tax AMOUNT

- **Where:** `tools/invoice.ts:497-509` (`totalsMoney`) / `:477-481` (`lastMoney`).
- **Failure scenario:** rate-only line `MwSt 20,00 %` → filler-only remainder → tax totals line → `lastMoney` matches `20,00` → `taxTotal = 20.00`. Both `netPlusTaxIsGross` and `taxMatchesRate` then report mismatch; decimal-shaped reads are exempt from `dropUncorroboratedWeakTotals` by design, so the wrong figure persists. (The existing `'VAT 20%  65,00'` test covers only a bare-integer rate, which `MONEY_RE` already rejects.)
- **Fix:** blank percent-attached figures (`/\d[\d.,']*\s*%/`) before the money scan in `lastMoney`/`totalsMoney`, mirroring the date scrub. Add a `MwSt 20,00 %` test.

### T-4 — de-AT vocabulary gap: line-leading `USt` / `Steuerbetrag` become phantom LINE ITEMS

- **Where:** `tools/invoice.ts:293-294` (`NET_LABELS`/`TAX_LABELS`).
- **Failure scenario:** `USt 20% 182,80` (the standard Austrian abbreviation — the de-AT target locale) matches no tax label (`'ust'` exists only in `TOTALS_FILLER`); `Steuerbetrag 182,80` is blocked because `labelBoundaryOk` refuses `steuer` as a prefix of a longer word (collateral of the §5.2 `Steuerberatung` fix). Both fall through to `parseLineItem` → phantom item `{description: 'USt 20%', lineTotal: 182.8}` → `taxTotal` missing **and** the net check corrupted — the same phantom-summary-item class audit §5.4 fixed for `Summe`. Partially known (known-limitations.md notes the `USt` gap) — **carried-forward, now with the phantom-line-item consequence made explicit.**
- **Fix:** add `'ust'`, `'steuerbetrag'` to `TAX_LABELS` and `'nettosumme'` to `NET_LABELS` (safe: `USt-IdNr: ATU…` still falls through — its remainder is not filler-only). Bump `INVOICE_EXTRACTOR_VERSION`.

### T-5 — SKA-14 amount gate misses the date branches: a date-label line carrying a figure silently swallows the figure

- **Where:** `tools/invoice.ts:582-597` (`applyHeader` date branches; the gate at `:557` covers vendor/number/recipient only).
- **Failure scenario:** `Rechnungsdatum: 03.05.2026 Betrag: 1.500,00 EUR` (flattened header/summary combo) → date branch consumes the whole line → the **1.500,00 is lost** and `droppedRowCount` is not incremented — the "whole invoice" honesty claim stands while a figure vanished. Exactly the harm class SKA-14 closed for the other header branches.
- **Fix:** gate the date branches on `carriesAmountShapedMoney` too (line falls to `parseLineItem`), or count the discarded figure into `droppedRowCount`. No test covers this shape.

### T-6 — Dotted header dates never vote in date-order inference: the `dd.mm` fragment matches `MONEY_RE`, suppressing the `'default'` honesty caveat

- **Where:** `tools/money.ts:390` (`inferDateOrderResult`).
- **Failure scenario:** invoice whose only date is `Datum: 05.03.2026`. Verified: `'Datum: 05.03.2026'.match(MONEY_RE)` → `[' 05.03']`, so the line takes the transaction-row branch; `tokens[0] = 'Datum:'` is not a date → no vote → `inferred = 'evidence'` — but 05.03 was read day-first by pure default and should flag `'default'`. The FIN-4 "money-less line votes globally" branch effectively never fires for dotted 4-digit-year dates.
- **Fix:** classify with the date-scrubbed `hasMoneyToken(line)` instead of raw `line.match(MONEY_RE)`. Pin `inferDateOrderResult('Datum: 05.03.2026').inferred === 'default'`.

### T-7 — `taxMatchesRate` has no per-line-rounding tolerance — legally correct invoices flag `mismatch`

- **Where:** `tools/invoice.ts:1001-1007` (`validateInvoiceTotals`).
- **Failure scenario:** 3 items net 33,33 each at 20%: printed per-line-rounded tax 3 × 6,67 = **20,01**; check computes `round2(99.99 × 0.20) = 20.00`; `agree` at `MONEY_EPS = 0.005` demands exact cent equality → `taxMatchesRate: 'mismatch'`, `reconciled: false` — a false arithmetic-error claim about a correct invoice, which also feeds `dropUncorroboratedWeakTotals`' retraction decisions.
- **Fix:** widen this one check to cover sum-of-rounded vs rounded-of-sum divergence (e.g. ±max(1 cent, `lineItems.length` × 0.5 cent)), or report a distinct "within rounding" status. No test exercises per-line-rounded VAT.

### P-2 — A cancelled or transiently-failed geometry retry permanently burns the one retry

- **Where:** `analysis/invoice.ts:661-676`.
- **Failure scenario:** invoice persisted `'suspect'` → geometry retry starts (a full layout re-parse, seconds on a big PDF) → user presses Stop → `runInvoiceExtraction` returns `{ok:false, cancelled:true}` → `retry.ok` is false so `textQuality` stays `'suspect'` → the handler stamps `'suspect-confirmed'` though **zero** geometry passes completed. Every later turn skips the retry; combined with P-1 the document is permanently stuck at the refusal. Same for a transient reader failure. This is also durable work **committed in direct response to a Stop**. Verified: the promotion at `:672` sits outside the `retry.ok` branch.
- **Fix:** promote to `'suspect-confirmed'` only inside the `retry.ok` branch; on `retry.cancelled` propagate the abort (see P-3). Test gap: `skills-analysis-invoice.test.ts:784` pins completed-retry finality only.

### P-3 — Stop during the analysis auto-run is swallowed: a misleading "could not read" answer (or a full answer) is committed after cancel

- **Where:** `analysis/invoice.ts:642-646` and `:748-749`; `ipc/registerRagIpc.ts:529-539`; `ipc/chat-stream.ts:213-226`.
- **Failure scenario:** fresh extraction runs for seconds → Stop → `{ok:false, cancelled:true}` → handler returns `{answer: tr('skills.invoiceAnalysis.couldNotRead'), …}` → the template branch `sendToken(answer)` + `appendMessage(...)` persist "This invoice could not be read" as a durable assistant message. `withChatStream`'s calm-cancel fires only when `runFn` **throws** while aborted — a returned answer sails past it. A Stop landing during `runInvoiceTotalsValidation` yields `output: undefined` → pure-recompute fallback → a full answer streamed/persisted after cancel. (The doc-lock abort covers a Stop while *parked* only, per its SKA-24 contract.) The bank handler (`analysis/bank-statement.ts:840-843`) has the identical gap.
- **Fix:** when `extraction.cancelled` (or `ctx.signal?.aborted` before the final return) throw a `DOMException(…, 'AbortError')` — `withChatStream` already maps that to the empty-message calm cancel. Test gap: no test aborts mid-analysis-run and asserts no assistant message was appended.

### P-4 — Every non-format invoice analysis question re-parses the whole document from disk and throws the result away (perf)

- **Where:** `invoice-run.ts:285-288` (`INVOICE_RUN_CONFIG.buildDownstreamReader`), `run.ts:122-146` (`resolveDocumentReader` eager `await deps.readDocumentSegments(...)`), `:488` (call site).
- **Failure scenario:** every template/grounded-data question on an invoice goes handler → `runInvoiceTotalsValidation` → `prepareDomainRun` → full document re-extraction (decrypt + PDF parse + OCR-page materialization) even though `validate_invoice_totals` takes structured input and never reads a chunk. The bank config binds a lazy no-I/O chunk reader instead. On a 50-page encrypted PDF on a slow portable drive this dominates the "deterministic, ~ms" answer path and **holds the per-document lock the whole time**, blocking queued runs on that document. Acknowledged in the A1 record (`run.ts:306-313`, "left to a follow-up") — reported because it sits on the hot chat path and the follow-up has no owner. **Carried-forward/known.**
- **Fix:** switch `INVOICE_RUN_CONFIG.buildDownstreamReader` to the bank's lazy `buildReadDocumentChunks(db, new Set([documentId]))` (or a lazy thunk); update the pinned call-count test. Note the audit-P-1 call-count test pins row reads but not segment-reader invocations, which is why this is invisible to the suite.

### D-1 — Live decision D58 ("layout mode is bank-statement ONLY") contradicts the shipped invoice geometry retry

- **Where (doc):** `docs/architecture.md:4394-4396` (§21 D58) and `docs/known-limitations.md:994`; **code:** `analysis/invoice.ts:661-666`.
- **Contradiction:** D58 says *"Layout mode is bank-statement ONLY … Redaction/preview/translate/compare/ingest never set `layout`"* and known-limitations echoes *"Enabled for bank-statement only"* — but since invoice-hardening-2026-07-04 P3 the invoice analysis handler re-extracts through `readDocumentSegments(id, { layout: true })` on a glyph-soup verdict. Both files describe the retry correctly *elsewhere* (§42; known-limitations:365-374), so each now internally contradicts itself.
- **Fix (doc side):** annotate D58 with a superseding note ("amended by §42 P3: the invoice *analysis* path re-extracts once via layout on a `textQuality:'suspect'` verdict; the run-bar extract stays reading-order") and qualify known-limitations.md:994 the same way. D58's own escape clause ("adopt layout there only behind its own measurement") was satisfied by the `invoice-de-geometry-columns` fixture, so the amendment is consistent.

---

## LOW

### T-8 — Bare `(netto)` qualifier on a gross-label total is not recognized

`tools/invoice.ts:485` (`EXCL_TAX_RE`) + `:644`. `Summe (netto) 914,00` → `summe` matches GROSS, `netto` is filler, `EXCL_TAX_RE` has no bare `netto`/`net` → net lands in `grossTotal`; a two-line `Summe (netto)…/Summe (brutto)…` block records only the second. **Fix:** add `\bnetto\b`/`\bnet\b` to `EXCL_TAX_RE` (only consulted after a GROSS label matched).

### T-9 — Schema validator uses prototype-chain `in` against `properties`

`tool-registry.ts:87-94` (`validateNode`). `'constructor' in props` is true via `Object.prototype`, so own input keys named `constructor`/`toString`/… pass `additionalProperties: false` unflagged (same pattern for the required-key check at `:84`). Defense-in-depth only — nothing later dereferences the extra keys. **Fix:** `Object.prototype.hasOwnProperty.call(props, key)` (the registry lookup at `:253` already does this correctly).

### T-10 — Wrapped-description continuation gate uses raw `MONEY_RE` instead of `hasMoneyToken`

`tools/invoice.ts:864-868`. A money-less date follower (`Leistungszeitraum: 01.02.2026 bis 28.02.2026`) "carries a money token" via its `01.02` fragment → continuation lost (recall-only, conservative). Inconsistent with `:877` and the SKA-2 dates-aren't-money posture. **Fix:** `!hasMoneyToken(line)`. (Same root cause as T-6 — raw `MONEY_RE` where the date-scrubbed helper belongs.)

### T-11 — `lastCurrencyAdjacentInteger`: O(n²) slices + per-iteration RegExp compilation

`tools/money.ts:641-667`. Per match: two O(n) `slice` copies and two `new RegExp(...)` compilations; a hostile `9 € 9 € …` line costs O(n²). Bounded by segment size — perf nit. **Fix:** hoist the symbol regexes to module scope; test adjacency via index arithmetic.

### P-5 — Four single-row queries on the same `invoices` row per analysis question

`analysis/invoice.ts:169-193`, `:653-677`, `:764-765`. `loadInvoice` plus `loadDateOrderInferred`/`loadDroppedRowCount`/`loadTextQuality` (the last read twice after a retry). **Fix:** one projection (`loadInvoiceMeta`) returning the three provenance columns.

### P-6 — Citation building materializes every chunk's full text to select ≤12 citations

`analysis/common.ts:105-112` (`loadCitationChunks`, unbounded `SELECT … text FROM chunks`), `analysis/invoice.ts:259-270`. Whole document text in JS heap per question (also on the refusal path, `:714`), then head-8 + tail-4 kept and snippets cut to 280 chars. **Fix:** two bounded queries (`ORDER BY chunk_index LIMIT 8` / `DESC LIMIT 4`) or `substr(text,1,281)` in SQL.

### P-7 — Hard crash mid-run strands `skill_runs` rows at `'started'` forever

`run.ts:319-324` (`insertStartedRun` committed before the gate). B4 is enforced against in-process throws only; no startup sweeper exists (verified). Bookkeeping-only today; any future run-history UI shows eternal "started" runs. **Fix:** at workspace open, `UPDATE skill_runs SET status='failed', error=… WHERE status='started'` (mirroring the document `queued→failed` crash-reconcile pattern).

### P-8 — `domainPersistFailure` / `prepareDomainRun` catch-paths call `finishRun` unguarded

`run.ts:518-528`, `:508-513`; contrast the guarded `finishTail` at `:587-598`. If the DB write that failed the persist also fails the terminal `finishRun` UPDATE (workspace locked/DB gone — exactly the situation that produces persist failures), the exception escapes uncaught: run strands at `'started'` **and** the seam rejects with a raw error instead of the content-free failure envelope. **Fix:** same try/retry/log pattern as SKA-27's `finishTail`.

### D-2 — Stale code comments assert "Invoices are never geometry-reconstructed" at tool-run dispatch

`tool-runs.ts:362` and `:377` cite D58 as absolute; true only for the run-bar/IPC path they sit on (see D-1). **Fix:** rescope both comments to "the run-bar path never sets `layout`; the one geometry read is the analysis handler's P3 suspect retry (§42)".

### D-3 — architecture.md §8 still says "three" invoice tools/labels; there are five

`docs/architecture.md:3185-3186`, `:3218-3220` vs `tool-registry.ts:243-247`, `shared/skill-tools.ts:162-206`, `i18n/en.ts:199-203`. The pre-JSON/XML count survived the invoice-format-2026-07-01 addition in two sentences (the same § documents the JSON/XML additions at `:3191-3194`). **Fix:** "three" → "five".

### D-4 — SKILL.md body omits the JSON/XML exports its own frontmatter grants

`app-skills/invoice/SKILL.md:63-66` (body) vs `:23-24` (`allowedTools`) and `tools/invoice.ts:1194-1219`. The model-facing body describes only the CSV export; JSON/XML carry header + totals, not just line items. **Fix:** extend the body sentence ("…or the whole invoice (header, line items, totals) to JSON or XML").

### D-5 — No troubleshooting entry for the glyph-soup "text doesn't extract cleanly" refusal

`docs/troubleshooting.md:223-236` covers scanned/empty PDFs only; the P3 refusal (`skills.invoiceAnalysis.unreadableLayout`, `analysis/invoice.ts:655-676`) and its once-per-document finality (re-import/re-index to retry) are maintainer-documented (§42, known-limitations:365-374) but not user-documented. **Fix:** add a bullet: what the message means, the OCR/original guidance, and that the retry happens once per document. *(Note: until P-1/P-2 are fixed, "re-import" is the only path that actually works — OCR-in-place does not clear the flag.)*

---

## Cross-cutting themes

1. **Raw `MONEY_RE` vs the date-scrubbed `hasMoneyToken`** — T-6 and T-10 are the same root cause in two places; a sweep for remaining raw `MONEY_RE` line-classification uses is cheap insurance.
2. **Cancellation stops at the seam** — SKA-24 parking and the run-seam cancel are solid, but the *analysis handlers* convert cancel into failure-or-fallback (P-2, P-3): cancelled work is either committed (a durable `suspect-confirmed` flag, a persisted wrong answer) or silently degraded. The bank handler shares both gaps.
3. **The P-1 + P-2 compound** is the worst user journey found: soup → refusal telling the user to OCR → OCR → same refusal forever; and a Stop pressed at the wrong moment produces the same permanent state. Fixing P-1 (purge on re-index) alone dissolves most of it.
4. **Test suite pins the happy paths** — the consolidated gaps (T-1/T-2/T-3/T-4/T-5/T-6/T-7 shapes, cancelled/failed retry, mid-run abort, re-index-between-questions, segment-reader call counts) are each one adversarial fixture away from being pinned; several existing describe blocks are the natural home.

## Remediation phase plan

Each phase is designed to run in a **fresh session**. Per-phase ritual (CLAUDE.md): start by reading `CLAUDE.md`, `BUILD_STATE.md`, then this report's phase section and every finding it cites (the finding bodies above carry the file:line evidence — re-verify against the live code first, line numbers may have drifted). End with: `npm test` green, `npm run typecheck` clean, the **status ledger below updated** (phase row → DONE + commit hash; per-finding deviations noted), `BUILD_STATE.md` updated, and a commit `fix(invoice-audit): IA-<n> — <summary> (<finding ids>)`. Every behavioral fix lands with its pinning test (the gaps are itemized per finding and consolidated in T-12 / "Test-coverage gaps").

Order rationale: IA-1 dissolves the worst user journey (permanent refusal); IA-2 is the shared-path sign flip; IA-3 batches every parser change under ONE `INVOICE_EXTRACTOR_VERSION` bump; IA-4/IA-5 are behavior-adjacent and isolated; IA-6/IA-7 are cleanup + docs/close-out.

### Status ledger

| Phase | Findings | Status | Commit |
|---|---|---|---|
| IA-1 | P-1, P-2 (+ D-1, D-2 doc/comment halves) | **DONE** | `fix(invoice-audit): IA-1` (see git log / BUILD_STATE) |
| IA-2 | T-1, T-11 | **DONE** | `fix(invoice-audit): IA-2` (see git log / BUILD_STATE) — bumped `INVOICE_EXTRACTOR_VERSION` 11→12 + `BANK_EXTRACTOR_VERSION` 9→10 |
| IA-3 | T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-10 | **DONE** | `fix(invoice-audit): IA-3` (see git log / BUILD_STATE) — bumped `INVOICE_EXTRACTOR_VERSION` 12→13 + `BANK_EXTRACTOR_VERSION` 10→11 (T-6 shared) |
| IA-4 | P-3 | open | — |
| IA-5 | P-4 | open | — |
| IA-6 | T-9, P-5, P-6, P-7, P-8 | open | — |
| IA-7 | D-3, D-4, D-5 + close-out | open | — |

### IA-1 — Staleness on content change + retry-burn guard (P-1, P-2; D-1, D-2)

**Goal:** a re-indexed/OCR-re-ingested document re-extracts on the next question, and the one geometry retry is only "spent" when it actually completed.

1. **P-1:** in the re-index teardown (`services/ingestion/index.ts:750-761`), call `purgeSkillDataForDocument(db, id)` inside the same transaction (the simple option from the finding; only escalate to a content-fingerprint column if a reason emerges — decide and record). Check every path that replaces a document's text (re-index, OCR re-ingest, source-file fallback re-parse) funnels through the purged teardown. Covers the bank twin automatically (`purgeSkillDataForDocument` purges both).
2. **P-2:** in `analysis/invoice.ts:661-676`, move the `'suspect-confirmed'` promotion inside the `retry.ok` branch; on `retry.cancelled` propagate the abort (minimal here — full abort propagation is IA-4; at minimum do NOT stamp the flag and do not answer from the half-done state).
3. **D-1/D-2** (this wave touches the retry, so the doc halves land here): amend D58 in `docs/architecture.md` §21 + `docs/known-limitations.md:994` with the §42-P3 superseding note; rescope the two `tool-runs.ts:362/:377` comments to the run-bar path.
4. **Tests:** (a) integration: import → ask (soup refusal) → re-index with clean text → ask again → real answer (red today); (b) same for a silent-content-change (non-soup) case asserting re-extraction, invoice AND bank; (c) unit: cancelled retry (`{ok:false, cancelled:true}`) leaves `text_quality='suspect'`; (d) failed (thrown) retry likewise. Keep `skills-analysis-invoice.test.ts:784` (completed-retry finality) green.

**Done when:** the P-1 failure journey (OCR → same refusal forever) is impossible; suite + typecheck green; ledger/BUILD_STATE/commit per ritual.

**Disposition (SHIPPED):**
- **P-1 — FIXED (simple option, no fingerprint column).** `purgeSkillDataForDocument(db, documentId)` now runs inside the re-index teardown transaction in `services/ingestion/index.ts` `prepareDocument` (right after the chunks/embeddings/tree deletes, before the fresh insert). **Verified the single funnel:** every text-replacement path — re-index, OCR re-ingest, and materialize — goes through `processDocument` → `prepareDocument`, and the import loop calls `prepareDocument` directly; a grep confirmed the only production `DELETE FROM chunks WHERE document_id` sites are this teardown and `purgeDocumentDerivatives` (delete path, already purged). Covers the **bank twin** automatically (`purgeSkillDataForDocument` deletes bank_statements + invoices and children). A first-time import has no rows → the purge is a no-op. The escalate-to-fingerprint option was NOT taken (no reason emerged).
- **P-2 — FIXED.** In `analysis/invoice.ts`, the `'suspect-confirmed'` promotion + its `UPDATE` now live **inside** the `retry.ok && retry.invoiceId` branch, so a cancelled or transiently-failed geometry retry (`{ok:false}`) leaves `text_quality='suspect'` intact for a later turn. Verified the two failure classes are distinguished at the seam: a reader throw with `signal.aborted` → `{cancelled:true}`; without abort → transient failure — both non-ok, both skip the promotion. Full abort→calm-cancel propagation stays deferred to **IA-4** (this phase only stops burning the retry / stamping the flag off a half-done state).
- **D-1 / D-2 — FIXED.** D58 (`docs/architecture.md` §21) and `docs/known-limitations.md` both carry the §42-P3 superseding note (the invoice *analysis* path re-extracts once via layout on a `text_quality:'suspect'` verdict; the run-bar extract stays reading-order). The two `tool-runs.ts` comments (`extract_invoice` re-extract + `validate_invoice_totals` no-layout) are rescoped to "the run-bar path never sets `layout`; the one invoice geometry read is the analysis handler's P3 suspect retry."
- **Tests:** `skills-analysis-invoice.test.ts` +2 (cancelled retry / failed retry both leave `'suspect'`; the completed-retry finality test at the former :784 stays green). New `invoice-audit-ia1.test.ts` (+4, full ingestion pipeline): soup→refusal→re-index-clean→real answer; invoice silent-content-change re-extracts (new figures, not stale); bank silent-content-change re-extracts; re-index purges BOTH twins' rows. **Suite 3590/47** (was 3584; +6). typecheck green.

### IA-2 — Leading-sign space gate in the shared money parser (T-1, T-11)

**Goal:** a dash separated from the figure by whitespace is text, not a sign — on the plain path, matching the geometry path's posture; and `lastCurrencyAdjacentInteger` stops doing O(n²) work.

1. **T-1:** in `tools/money.ts` `MONEY_RE`, make a leading `-` sign only when glued to the digit/paren (`-(?=[\d(])`), keeping `\s{0,4}` only after `(`; update the ReDoS doc comment (`:141-159`) to match. Apply the same glue rule to `lastCurrencyAdjacentInteger`'s sign rebuild (`:660`). Audit `parseAmount` (`:185`) — after the regex change its `/^[-]/` input can no longer carry a spaced dash, but confirm no other caller feeds it raw text.
2. **T-11** (same function): hoist the two `new RegExp` currency-symbol patterns to module scope; replace the per-match `slice` copies with index arithmetic.
3. **This is the SHARED parser** — bank-statement consumes `MONEY_RE` too. Run the full bank suite; expect the R1 glued-sign tests (`skills-bank-statement-tool.test.ts:1639`) to stay green, and check the documented residual list (known-limitations) for entries this change closes or alters.
4. **Tests:** R1-style pair on the plain path: spaced ASCII dash and spaced en-dash separators read as POSITIVE (`Beratung – 1.500,00 EUR` → +1500, `GUTSCHRIFT - 34,39` → +34.39, `Gesamt - 914 EUR` integer fallback → +914); glued `-1.500,00` still negative; `( 914,00 )` paren-negative unchanged. Plus a plain-vs-geometry agreement test on `'LASTSCHRIFT - 3,99'` (mirror of `pdf-layout.test.ts:570`).
5. Extractor-version note: `MONEY_RE` feeds both extractors — check whether the bank/invoice extractor versions must bump for this (they should: persisted rows parsed under the old sign rule are now wrong-by-fixed-bug). If yes and IA-3 hasn't run, bump `INVOICE_EXTRACTOR_VERSION` (and the bank twin) here and note it in the ledger so IA-3 doesn't double-bump needlessly.

**Done when:** spaced-dash layouts parse positive on both paths; no bank regressions; ritual complete.

**Disposition (SHIPPED):**
- **T-1 — FIXED.** `MONEY_RE`'s leading class is now `(?:[-+](?=[\d(]))?(?:\(\s{0,4})?` — a leading `-`/`+`
  is consumed as a sign ONLY when GLUED to the magnitude or an open paren; the `\s{0,4}` gap survives only
  after `(` (the parens-negative `( 914,00 )` form). A dash separated from the figure by whitespace is now
  text: `Beratung – 1.500,00 EUR` (Word en-dash → `-` via the R1 pre-pass) reads **+1500**, `GUTSCHRIFT -
  34,39` reads **+34,39**, and the plain path now AGREES with the geometry path on `LASTSCHRIFT - 3,99`
  (both positive). `lastCurrencyAdjacentInteger`'s sign rebuild applies the same glued-leading rule
  (`Gesamt - 914 EUR` → +914; glued `Gesamt -914 EUR` still −914). The ReDoS/leading-sign doc comment and
  the `MONEY_RE` "Leading sign — GLUED-only" paragraph were updated. **`parseAmount` audit:** every caller
  feeds either a `MONEY_RE`/`scanMoneyWithBlankedDates` token or the controlled `signed` rebuild — none
  feed raw spaced-dash text, so `parseAmount`'s own `/^[-]/` negative rule needs no change.
- **T-11 — FIXED.** The two per-match `new RegExp('[€$£¥]…')` compilations and the per-match
  `text.slice(0, start)` / `text.slice(end)` copies (O(n²) on a hostile `9 € 9 € …` line) are gone.
  Adjacency is now an index walk to the nearest non-whitespace neighbour on each side + a hoisted
  `CURRENCY_SYMBOL_SET` membership test and bounded index checks for the ISO code (`ISO_CODES.has`), all
  O(n) total. **Deviation (recorded):** the two symbol regexes were *replaced* by Set membership rather
  than merely hoisted — this subsumes the hoist (zero per-match compilation) and is what actually kills the
  O(n²); the code/lead/trail regex *literals* (already compiled once) became index arithmetic to eliminate
  the slices. Behaviour is byte-preserving except the T-1 leading-glue change (verified: bank/invoice/
  pdf-layout unit suites green with no output moves).
- **Shared-parser discipline.** `MONEY_RE` feeds the bank extractor too; the full bank suite (incl. the R1
  glued-sign tests at `skills-bank-statement-tool.test.ts` ~:1639, all trailing/glued) stays green. The
  extractor-realworld snapshot regenerated with **only the two version fields changed** — no corpus fixture
  carries a spaced-leading-dash, so no persisted-output moved.
- **Extractor-version decision (bumped in IA-2).** Persisted rows parsed under the old sign rule are
  wrong-by-fixed-bug (a `- 1.500,00` layout stored −1500), so **both** twins bumped here:
  `INVOICE_EXTRACTOR_VERSION` **11 → 12**, `BANK_EXTRACTOR_VERSION` **9 → 10** — stale rows re-extract via
  `isInvoiceStale`/`isBankStatementStale`. **IA-3 must NOT re-bump for this fix** (its batch bump still
  happens once for the IA-3 parser changes; it starts from 12/10, not 11/9).
- **Tests:** `money.test.ts` +5 (a new `MONEY_RE leading-sign glue gate (T-1)` describe): spaced ASCII/en-
  dash → positive; glued dash → negative; `( 914,00 )` parens-negative unchanged; the integer-fallback
  mirror (`Gesamt - 914 EUR` +914 / glued −914 / `$914-` −914); the plain-vs-geometry agreement on
  `LASTSCHRIFT - 3,99`. Version-pin tests moved (invoice 11→12, bank 9→10 in two files). **Full suite
  3595/47**, typecheck green. Docs: known-limitations.md BL-1 entry extended with the leading-side rule.

### IA-3 — Parser/vocabulary batch, one extractor-version bump (T-2..T-8, T-10)

**Goal:** the seven independent parser fixes land together under a single `INVOICE_EXTRACTOR_VERSION` bump (skip the bump only if IA-2 already bumped and nothing here changes persisted shape — it does, so bump).

Work through the findings in file order, each with its pinning test (shapes are in the finding bodies):
1. **T-3 + T-6 + T-10 (root cause: raw `MONEY_RE` where a scrubbed helper belongs):** blank percent-attached figures before the money scan in `lastMoney`/`totalsMoney` (T-3); switch `inferDateOrderResult`'s line classifier (`money.ts:390`) and the continuation gate (`invoice.ts:864-868`) to `hasMoneyToken` (T-6, T-10). Then do the cross-cutting sweep (theme 1): grep remaining raw `MONEY_RE` line-classification uses; fix or explicitly clear each.
2. **T-2:** multi-label totals line — split at each boundary-matched label and read the figure nearest after its own, or refuse (drop-don't-guess). Pick one, record why.
3. **T-4:** add `'ust'`, `'steuerbetrag'` to `TAX_LABELS`, `'nettosumme'` to `NET_LABELS`; verify `USt-IdNr: ATU…` still falls through; remove/adjust the known-limitations `USt` residual note.
4. **T-5:** gate the `applyHeader` date branches on `carriesAmountShapedMoney` (or count into `droppedRowCount` — pick the gate, it's the SKA-14 precedent).
5. **T-7:** widen `taxMatchesRate` for per-line rounding (±max(1 cent, n×0.5 cent)) or a distinct "within rounding" status — pick, record.
6. **T-8:** add `\bnetto\b`/`\bnet\b` to `EXCL_TAX_RE`.
7. Bump `INVOICE_EXTRACTOR_VERSION` once; confirm the stale-row re-extraction path picks it up (that's `isInvoiceStale` — after IA-1 also content-purge, fine).

**Done when:** each finding has a red-then-green test; one version bump; ritual complete.

**Disposition (SHIPPED):**
- **Root-cause group (T-3 + T-6 + T-10) — FIXED.** (T-3) `lastMoney` now scans over a `blankPercentFigures(stripDateTokens(line))` copy (new module-scope `PERCENT_FIGURE_RE = /\d[\d.,']*\s*%/g`), so a rate-only line `MwSt 20,00 %` reads NO tax amount (only `taxRatePercent=20`), and `MwSt 20% 65,00` reads only 65,00. `totalsMoney`'s bare-integer fallback needs no separate scrub — a percent figure is never currency-adjacent. (T-6) `inferDateOrderResult`'s line classifier switched from raw `line.match(MONEY_RE)` to the date-scrubbed `hasMoneyToken(line)`, so a money-less dotted date `Datum: 05.03.2026` reaches the header/label vote branch and flags `'default'`. (T-10) the invoice wrapped-continuation gate switched from `[...line.matchAll(MONEY_RE)].length === 0` to `!hasMoneyToken(line)`, so a money-less date follower `Leistungszeitraum: 01.02.2026 bis 28.02.2026` keeps its continuation. **Theme-1 sweep (explicitly cleared):** the remaining raw-`MONEY_RE` sites are NOT date-classification bugs — `isFillerOnly` (`.replace(MONEY_RE,' ')`) and `carriesAmountShapedMoney` both `stripDateTokens` first; `isSummaryLabelLine`'s `split(MONEY_RE)[0]` only feeds `isFillerOnly` (which re-scrubs dates) and is conservative (a date-as-split-point can only make a phantom-summary drop *more* likely, and it runs only after `applyTotals`/`applyHeader` had first claim); `detectDocumentCurrency` and `scanMoneyWithBlankedDates` scrub/blank dates before their scans. No further change.
- **T-2 — FIXED (SPLIT, not refuse).** A one-line multi-label totals row (`Netto 1.000,00 MwSt 200,00 Brutto 1.200,00`) is handled by the new `readMultiLabelTotals`/`segmentTotalsKey`: each figure (found on a SAME-LENGTH date-/percent-blanked copy so a `dd.mm`/`20%` fragment is never a figure; the VALUE parsed from the original bytes) is attributed to the boundary-matched totals label in the filler-only run immediately BEFORE it. **Decision — split over refuse:** the audit lists split first and it *recovers* net/tax/gross correctly rather than dropping the row; the engage guard is strict enough to stay honest — it fires only when there are ≥2 figures, EVERY figure is preceded by a filler-only run ending in a boundary-matched totals label (so a description-leading item like `Miete netto 1.000,00` — "miete" is not filler — never engages), and ≥2 DISTINCT fields resolve; anything else returns null and falls through to the unchanged single-label path.
- **T-4 — FIXED.** `'nettosumme'` added to `NET_LABELS`; `'steuerbetrag'`, `'ust'` added to `TAX_LABELS`. `USt 20% 182,80` / `Steuerbetrag 182,80` / `Nettosumme 914,00` now resolve to tax/net totals; `USt-IdNr: ATU81420204` still falls through (its remainder `idnr atu…` is not filler-only, so `isTotalsLine` refuses it, and no money token → no phantom item). The known-limitations `USt`-not-in-`TAX_LABELS` residual note was rewritten as **closed by T-4**.
- **T-5 — FIXED (GATE, not count).** `applyHeader` now early-returns `false` on `carriesAmountShapedMoney(line)` for ALL header branches (vendor/number/recipient AND the date branches — the SKA-14 gate previously covered only the first three). `Rechnungsdatum: 03.05.2026 Betrag: 1.500,00 EUR` falls through to `parseLineItem`, so the 1.500,00 surfaces as a line item instead of vanishing. **Decision — gate over count (SKA-14 precedent):** the accepted trade-off is that the DATE on such a combined line is not captured (drop-don't-guess prefers not losing a figure); a bare `Rechnungsdatum: 03.05.2026` (no amount) still consumes as a header.
- **T-7 — FIXED (WIDEN tolerance, not new status).** `taxMatchesRate` compares `|expected − taxTotal| ≤ max(1 cent, lineItems.length × ½ cent) + MONEY_EPS`, so a per-line-rounded VAT invoice (3×6,67 = 20,01 vs `round2(99.99×0.20)=20.00`) reads `ok`. **Decision — widen over a distinct "within rounding" status:** a new status would ripple through the answer layer + i18n + types; the widened bound is the exact sum-of-rounded-vs-rounded-of-sum divergence and still catches a genuine tax error (a euro-off tax still `mismatch`). This is a downstream validation-check change reading no persisted field differently, so it did **not** itself warrant the version bump.
- **T-8 — FIXED.** `EXCL_TAX_RE` gained `\bnetto\b`/`\bnet\b` (only consulted AFTER a GROSS label matched), so `Summe (netto) 914,00` lands in `netTotal`, not `grossTotal`.
- **Shared-parser / bank-bump decision (BUMPED).** T-6 edits the SHARED `money.ts inferDateOrderResult`, which feeds `date_order_inferred` on BOTH twins. The full bank suite is green, and the regenerated `extractor-output.snapshot.json` shows the change moved exactly TWO invoice fixtures — `invoice-ch-summe-apostrophe` and `invoice-de-unreconcilable-totals` — and ONLY their `dateOrderInferred: 'evidence' → 'default'` (both carry a money-less order-ambiguous dotted date read day-first by default → the caveat *should* fire; no amounts/items/order moved). No BANK corpus fixture moved, but a money-less dotted PERIOD header on other statements *can* change the inferred order (and thus persisted dates), so **`BANK_EXTRACTOR_VERSION` bumped 10 → 11** on the correctness/staleness principle. `INVOICE_EXTRACTOR_VERSION` bumped **12 → 13** once for the whole IA-3 parser batch (v13 history entry added; did NOT re-bump for the IA-2 T-1 fix).
- **Tests:** `money.test.ts` +1 (T-6: `Datum: 05.03.2026` → `'default'` + a money-less dotted US period header now votes `mdy`); `skills-invoice-tool.test.ts` +8 in a new `IA-3 — parser batch` describe (T-3 rate-not-amount + rate-shares-line; T-2 split + no-hijack-of-`Miete netto`; T-4 USt/Steuerbetrag/Nettosumme + USt-IdNr fallthrough; T-5 figure-surfaces + bare-date-still-consumes; T-7 within-rounding-ok + euro-off-still-mismatch; T-8 net-not-gross; T-10 continuation kept). Version pins updated in `skills-invoice-tool.test.ts` (13), `skills-bank-statement-tool.test.ts` (11), `skills-run.test.ts` (11). Snapshot regenerated. **Full suite 3604/47** (was 3595; +9), typecheck green.

### IA-4 — Abort propagation in analysis handlers, invoice + bank twin (P-3)

**Goal:** Stop during an analysis auto-run produces the calm-cancel (empty message, nothing persisted) — never a committed "could not read" or a full answer.

1. In `analysis/invoice.ts` (`:642-646`, `:748-749`): when `extraction.cancelled` / `retry.cancelled` / validation-run cancelled, or `ctx.signal?.aborted` before the final return, throw `DOMException(…, 'AbortError')` — `withChatStream` (`ipc/chat-stream.ts:213-226`) already maps a thrown abort to the calm cancel.
2. Same change in `analysis/bank-statement.ts` (`:840-843` and its validation fallback).
3. Verify the seam contract: `runInvoiceExtraction`/`runInvoiceTotalsValidation` reliably distinguish `cancelled` from failure on every path (a transient failure must still produce `couldNotRead`, only a genuine cancel converts to abort).
4. **Tests:** abort `ctx.signal` mid-run (fresh extraction, geometry retry, and validation seam) and assert NO assistant message appended + no `couldNotRead` returned, invoice and bank; a genuine (non-cancel) failure still returns `couldNotRead`.

**Done when:** a Stop at any point in the analysis run leaves no durable trace; ritual complete.

### IA-5 — Lazy invoice downstream reader (P-4)

**Goal:** a template/grounded-data invoice question stops re-parsing the whole document from disk per question.

1. Read the A1 record first (`run.ts:306-313`) — this is the follow-up it defers; the record's constraints define the acceptance bar.
2. Switch `INVOICE_RUN_CONFIG.buildDownstreamReader` (`invoice-run.ts:285-288`) to the bank's lazy `buildReadDocumentChunks(db, new Set([documentId]))` or a lazy thunk that only invokes the segment reader if a tool actually reads. Confirm no invoice downstream tool reads chunks/segments (per the finding, `validate_invoice_totals` takes structured input — verify for the export tools too, which also run downstream).
3. Update the pinned call-count test, and add the missing instrumentation: a test pinning **segment-reader invocation count = 0** on the validation path (the gap that hid this).
4. Sanity-check lock hold time: the point of the fix is the per-document lock is no longer held across a full re-parse.

**Done when:** zero segment-reader calls on non-format questions, pinned by test; ritual complete.

### IA-6 — LOW hardening batch (T-9, P-5, P-6, P-7, P-8)

Independent small fixes; land as one commit or split freely:
1. **T-9:** `Object.prototype.hasOwnProperty.call(props, key)` in `validateNode` (`tool-registry.ts:84`, `:87-94`); test with an own `constructor` key against `additionalProperties: false`.
2. **P-5:** one `loadInvoiceMeta` projection replacing the three per-column reads (`analysis/invoice.ts:169-193`); drop the double `loadTextQuality` on the retry path.
3. **P-6:** bounded citation queries (head-8/tail-4 `LIMIT` or SQL `substr`) in `analysis/common.ts:105-112` — this is shared with redaction/other analysis callers; check all call sites.
4. **P-7:** startup sweeper `UPDATE skill_runs SET status='failed', error=… WHERE status='started'` at workspace open, mirroring the document `queued→failed` reconcile; test: seed a `'started'` row, open workspace, assert `'failed'`.
5. **P-8:** wrap the `finishRun` calls in `domainPersistFailure` + the two `prepareDomainRun` catch blocks (`run.ts:508-528`) in the SKA-27 `finishTail` try/retry/log pattern, always returning the friendly failure envelope; test: DB that fails both the persist and the first terminal UPDATE.

**Done when:** all five landed with tests where behavioral; ritual complete.

### IA-7 — Docs + close-out (D-3, D-4, D-5)

1. **D-3:** "three" → "five" at `docs/architecture.md:3185-3186`, `:3218-3220`.
2. **D-4:** extend the SKILL.md body sentence to cover JSON/XML exports (`app-skills/invoice/SKILL.md:63-66`). Note: SKILL.md is model-facing — keep the sentence in its existing plain style; check whether any skill-md parity test pins the body text.
3. **D-5:** add the glyph-soup refusal bullet to `docs/troubleshooting.md` ("skill tool found nothing" section): what the message means, OCR/original guidance, once-per-document retry. By now IA-1 has landed, so OCR-in-place DOES clear the state — write the entry against the fixed behavior.
4. **Close-out (doc lifecycle rule):** fold this audit into the architecture.md ledger pattern — add a per-finding disposition table (T-1…T-11, P-1…P-8, D-1…D-5 → fixed-in-commit / decision taken / deferred-because) as a §-numbered record next to the existing audit ledgers, then `git rm` this report (recoverable in history), update `BUILD_STATE.md` and the memory index entry (report retired, remediation complete).

**Done when:** durable record lives in architecture.md; this file is retired; final suite count noted in BUILD_STATE.md.
