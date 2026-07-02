# Skills Remediation Plan — execution plan for docs/skills-audit-2026-07-02.md

> **Status: OPEN — phase tracker in §0.2.** This is a working-paper plan (CLAUDE.md doc lifecycle):
> when ALL phases close, fold decisions into the topic docs as §-numbered design records, condense
> the audit into the same records, and delete both files (full text stays in git history).
>
> **How to use:** run **one phase per session**, in a fresh session. Paste the phase's "Session
> prompt" (verbatim) as the first message. Prompts are written for **Opus 4.8**: imperative,
> self-contained, explicit acceptance criteria, explicit non-goals, and hard context-budget rules.
> Phases are sized so a session completes implementation + tests + docs + commit **without
> approaching the context limit** — if a phase says SPLIT-POINT, the session may stop there cleanly.

---

## §0 Protocol — read this in EVERY session (it is short; the phase § has the detail)

**Start of session**
1. Read `CLAUDE.md` (auto-loaded), then THIS file: §0 + §0.2 (tracker) + your phase section ONLY.
2. Read the audit sections cited by your phase from `docs/skills-audit-2026-07-02.md` — **only
   those sections**, not the whole report.
3. Read the listed code files. For large files (`rag/index.ts`, `registerRagIpc.ts`,
   `ChatScreen.tsx`, `run.ts`) **grep for the named symbols first and read only the relevant
   ranges**. Line numbers in this plan are as of 2026-07-02 — if drifted, locate by symbol name.
4. **NEVER read `BUILD_STATE.md` in full (897 KB).** If you need history, Grep it with `-B2 -A20`.
   **NEVER read `docs/architecture.md` in full (~4,400 lines)** — read only cited § ranges.

**Context-budget rules (hard)**
- Do not open files outside the phase's file list unless a failing test forces you to; say so when
  you do. Do not paste large file contents into your responses — reference `file:line`.
- Run **targeted tests during development** (`cd apps/desktop && npx vitest run <paths>`), the
  **full canonical suite once at the end** (`npm test` from the repo root) plus `npm run typecheck`.
- Known pre-existing env artifacts: running `npx vitest` from the **repo root** shows
  `@shared/i18n` alias + `C:\model-manifests` ENOENT failures. They are absent under canonical
  `npm test`. Do not chase them.

**Rules of the work**
- Offline, no cloud APIs, no telemetry (CLAUDE.md §0). Deterministic paths stay deterministic:
  **the LLM never computes or moves a figure** — it may only narrate figures the parser produced.
- Schema changes are **additive only** (new tables full SQL, new columns nullable).
- Logs/audit carry **ids/counts only** — never content (questions, figures, skill bodies).
- Every extractor behavior change **bumps the affected extractor version by exactly 1**
  (`BANK_EXTRACTOR_VERSION` in `tools/bank-statement.ts`, `INVOICE_EXTRACTOR_VERSION` in
  `tools/invoice.ts`) so stale rows re-extract.
- i18n: every new user-facing string lands in **both** `shared/i18n/en.ts` and `de.ts`. German
  assistant-voice strings use **du** (not Sie) — U5 sweeps the legacy strings; don't add new Sie.
- New tests use realistic inputs (German layouts, NBSP/Unicode where relevant), not
  fixtures reverse-engineered from the parser. Never commit real user documents — construct
  realistic synthetic layouts.
- Report honestly: if a test fails or a step is skipped, say so plainly. Never weaken an assertion
  to make a suite pass — flag the conflict instead.

**End of session (per-phase ritual — a phase is NOT done without all of these)**
1. `npm test` green (repo root) + `npm run typecheck` green.
2. Update affected `docs/` topic docs (usually: `docs/known-limitations.md` — delete/adjust entries
   your phase resolves; sometimes `docs/rag-design.md` / `docs/architecture.md` skills record).
3. Update **this file §0.2**: mark the phase `[x]`, one-line outcome note.
4. Add a **compact dated entry** to `BUILD_STATE.md` (top, matching house style): what/why/root
   cause refs (`audit §…`), tests added, branch name.
5. Commit on branch `fix/skills-<phase-id>` (e.g. `fix/skills-r1`), message referencing the phase
   and audit §§. **Leave the branch unmerged** unless the owner says otherwise in-session.
6. Do **not** start the next phase, even with context to spare.

---

## §0.2 Phase tracker

| ID | Title | Prio | Deps | Size | Status |
|----|-------|------|------|------|--------|
| R1 | Character normalization + money sign fixes | P0 | — | S | [x] — `normalizeExtractionText` pre-pass at all money/row entry points (plain + geometry) + sign-aware bare-integer total; versions→4; 20 new tests. `fix/skills-r1` |
| R2 | Invoice/bank label & totals matching | P0 | R1 | M | [x] — structural (`labelBoundaryOk`) + `isFillerOnly` totals gate kills the `Steuerberatung`→taxTotal theft; last-block-wins; `isSummaryLabelLine` guard; NET/GROSS German labels extended; header date-labels consume only when a date parses; bank `Kontostand am/zum`; versions→5; probe fixtures added. `fix/skills-r2` |
| R3 | Stale-row runs + sepa prefilter demotion | P0 | — | S | [x] — staleness re-extraction in `prepareStatementRun`/`prepareInvoiceRun` (run-bar buttons + JSON/CSV/XML exports re-extract stale rows before serving; `needsExtraction` on failure; skipped when the caller passed `preloaded`); `tool-runs.ts` forwards the segment reader (+bank `layout`) to the downstream dispatches so the re-extraction reads faithful segments, not the newline-collapsed chunks (necessary supporting edit outside the file list — see BUILD_STATE); `sepa`/`überweisung` → `confident:false` so the LLM categorizer sees those rows (deterministic fallback still labels Transfer offline); cancel-vs-fail honoured in the re-extraction block; 20 net-new tests (mutation-verified); adversarial multi-agent review of the diff → 4 confirmed issues, all addressed. Branched off `fix/skills-r2` (the plan docs live there, not master). `fix/skills-r3` |
| R4 | Deterministic compare pair + scope-query consolidation | P0 | — | S | [x] — deleted both private in-scope-document queries (`registerRagIpc.ts`, `analysis/redaction.ts`); all sites route through the shared `documentsInScope(db, scope, {requireChunks:true})`, giving the compare pair the helper's `ORDER BY created_at, id`. Compare prompts (`buildCompareDiffPrompt`/`buildCompareWholeDocPrompt`) now label the pair `Document A/B: "title" (imported <date>)` and describe the diff as A→B with additions/removals attributed relative to A→B — never "old/new" (`what-changed` SKILL.md table + Added/Removed sections realigned to A/B). Grep hygiene test pins the in-scope-documents PROJECTION fingerprint (`d.id AS id` + `FROM documents d` + `status='indexed'`) to `scope-documents.ts` only — the plan's 2-substring pattern also hits legit COUNT/seed queries, so the id-projection column disambiguates. 3 net-new tests (deterministic import-order pair, honest labels on both diff+whole-doc paths, grep); full suite green. `fix/skills-r4` |
| R5 | Date correctness (yy-dates, cross-year, ambiguous flag) | P0 | — | M | [x] — anchor-gated `parseDate` (2-digit-year → anchor century, bare `dd.mm.` → anchor year; NO anchor still drops — posture pinned) + `inferDateAnchor` (first fully-printed 4-digit-year date, order-aware); cross-year month-rollover (`rollAnchorYear`) on BOTH the plain path and the geometry `toFullDate` (`resolvePageAnchor` now carries the anchor month, threaded across pages via `fallbackMonth`); additive `date_order_inferred` TEXT on `bank_statements`+`invoices` set to `'default'` iff order defaulted AND an order-ambiguous date was read, surfaced as ONE honest caveat line (en+de, du-form) appended by `buildBankAnswer`/`buildInvoiceAnswer`; `inferDateOrderResult` reports evidence-vs-default; anchor threaded through both extractors; versions→6. Adversarial multi-agent diff review caught a real HIGH honesty gap — the ambiguity sniff required a 4-digit year, so the caveat never fired on the dd.mm.yy/bare cohort R5 newly parses; fixed by loosening `AMBIGUOUS_DATE_TOKEN_RE` to the optional-year shape (+ 2 MEDIUM test-coverage gaps closed). 19 net-new tests (yy-anchor, no-anchor-zero explicit, cross-year geometry+plain, mdy/century-boundary/bare-decimal-reject, caveat en+de on bank+invoice, evidence-none, yy-only ambiguous→default, invoice parseLineItem anchor, fallbackMonth carry); full suite green (2816) + typecheck. Branched off master (R1–R4 already merged there). `fix/skills-r5` |
| R6 | Row fidelity: wrapped descriptions + column debris | P0 | R1, R2 | M | [x] — bounded (single-line) continuation association on the plain/CSV path (bank + invoice), **scoped per page/segment** so a page-2 header/footer can't glue onto page-1's last row (mirrors the geometry `reconstructPage` per-page flush); identity-gated invoice column-debris cleanup (leading row-index strip capped to 1–3 digits so a product year survives + trailing `<qty> <rate>%` split into `quantity` + a new optional `taxRatePercent`) that fires ONLY when `quantity × unitPrice ≈ lineTotal`, else the description is left intact (the audit probe `1 … 1 0% 76,17 914,00` stays uncleaned); `taxRatePercent` surfaced in JSON/XML + the extract schema (not CSV/DB — out of tools-only scope); versions→7 (both). Adversarial multi-agent diff review (4 lenses, each finding independently verified) caught a real **HIGH** cross-segment `pending` carry (fixed → per-chunk scoping) + a LOW leading-year clobber (fixed) + 3 test-coverage gaps (invoice version pin, money-guard closer, extract→export end-to-end — all closed); 16 net-new tests; full suite green (2832). `fix/skills-r6` |
| W1 | Whole-doc budget honesty | P1 | — | M | [x] — in-prompt partial-document notice (`buildGroundedPrompt`/`buildCompareWholeDocPrompt`: model told "sections 1–N of M", forbidden to assert an absence beyond them; compare prints it per truncated half); the 1.5 German-subword divisor applied to whole-doc + compare budgets via a new `wholeDocumentFitBudgetTokens` (both call sites) — the flagship de-AT whole-doc turn no longer risks the raw HTTP 400; consecutive same-segment chunks de-overlapped (metadata-gated on page/section, ~80-token overlap stripped byte-exact) in `retrieveWholeDocument` + `documentApproxTokenTotal` (compare-split sizing measures the same de-overlapped totals); tree path (`whole-doc-tree.ts`) now flips `coverage.truncated:true` + softens the reduce prompt on the 12-call map ceiling OR a notes-budget clamp (the "lies at the margin" bug), and the `CoverageMeter` renders a ready+truncated tree as "covers the beginning" (new `coverage.tree.beginning` en+de) instead of a leaf-fraction 100 % claim; de-overlap is CHARACTER-based (KMP) so it is correct + never-empties on space-less/glued runs; `buildCompareDiffPrompt` no longer claims a (now-more-often-capped) change list "complete and exact". +13 net-new tests (budget divisor, de-overlap/no-duplicate-markers + budget bound at a ~11-page German fixture@4096, cross-segment-gate + space-less-CJK de-overlap, `documentApproxTokenTotal` de-overlap, single+compare-half in-prompt notice, diff complete-vs-PARTIAL, tree ceiling + notes-truncation, ready-truncated badge); full suite green (2845) + typecheck. Adversarial 4-lens diff review (each finding independently verified) caught a real CRITICAL (word-level de-overlap emptied space-less chunks) + HIGH (diff "complete and exact" overclaim) + 4 MEDIUM/LOW test/clarity gaps — all fixed. Non-goals honored (W2 routing, A3 gate inversion, deep-index auto-build noted as follow-up). Branched off `fix/skills-r6`. `fix/skills-w1` |
| W2 | Doc-count fallthrough routing + plausibility gate | P1 | W1 | M | [x] — new doc-count-agnostic `SkillAnalysisHandler.intends()` + `SkillAnalysisResult.fallThrough`; shared `matchesSkillDocSignals` (selector.ts). `registerRagIpc` W2 pre-pass (before the applies() dispatch): intent-shaped + `!applies()` ⇒ single-doc handlers NARROW to the one manifest-signal match that is ALSO fully-chunked (honest `scopeNarrowed` notice — run() prepend / grounded `answerPrefix`), else ROUTE `selectOne`; `what-changed` at ≠2 ⇒ `selectTwo` (SKILL.md scope-policing paragraph rewritten — the model can't see the count). Plausibility gate in bank/invoice run(): zero rows + skill-declares-signals-but-doc-matches-none ⇒ `fallThrough` → ordinary grounded path (unsignalled/unreadable skill keeps the honest empty answer — D56 conservative). `generateGroundedAnswer`+`answerWholeDocFromTree` gained an additive `answerPrefix` (outside the plan file list — noted in BUILD_STATE). Adversarial 3-lens diff review (each finding verified) caught a real MEDIUM (narrow→refusal dropped the notice → only narrow to fully-chunked docs) + LOW (prefix-only empty-model turn persisted a coverage-stamped notice → prefix-only empty guard, both grounded + tree paths). 22 net-new tests; full suite green (2867) + typecheck. Residual (A3 territory, documented): the financial skills' broad `application/pdf` MIME means a contract *PDF* with the bank skill sticky still keeps the empty template — the filename pattern is the discriminating signal. Branched off `fix/skills-w1`. `fix/skills-w2` |
| W3 | Third mode (LLM over extracted data) — seam + invoice | P1 | R2 | L | [x] — new `SkillAnalysisResult` outcome `{mode:'grounded-data', dataBlock, postscript}`; `generateGroundedDataAnswer` streams a model answer over `buildGroundedDataPrompt(question, dataBlock, fence?)` (new `services/rag/grounded-data.ts`) under FIXED rules (answer only from the data, quote figures verbatim, NO arithmetic, say when the data lacks the fact, user's language) — the LLM never computes a figure. Invoice handler routes by ANSWER SHAPE: `detectFormat`→serializer (unchanged); a narrow word-anchored summary/reconcile/list stem list (+`warum`/`why` guard so "warum stimmen die Summen nicht?"→grounded-data)→template (unchanged); everything else that passed `applies()`→grounded-data. Deterministic **totals postscript** (net/tax/gross verbatim) under every model answer + the R5 date caveat rides it (due-date Qs now route here). `buildInvoiceAnswer` gained a **Details block** (vendor/number/dates) so the header gap dies on the template path too. `dataBlock`=`buildInvoiceJson`+reconciliation+provenance, capped ~150 rows; grounded-data uses its OWN system prompt (`GROUNDED_DATA_SYSTEM_PROMPT`, no `[Sn]` cite rule) + replays history (follow-ups no longer re-trigger the template). Adversarial 4-lens diff review (each finding independently verified) → 5 confirmed: MEDIUM [S1]-citation-rule mismatch (fixed via the dedicated system prompt), MEDIUM empty-arm test gap + 3 LOW (`stimmen` over-fire→word-anchored, redundant `reconcile` stem, scope-notice-on-grounded-data test) — all fixed. Bank port deferred to W4 (SPLIT-POINT honoured). +18 net-new tests; full suite green (2882) + typecheck. Branched off `fix/skills-w2`. `fix/skills-w3` |
| W4 | Third mode — bank port + format parity + follow-ups | P1 | W3 | M | [x] — ported W3's answer-shape routing to the bank handler: `detectFormat`→inline serialization (new pure `buildStatementJson` = rows + cashflow summary + balances; CSV reuses `transactionsToCsv`), `isSummaryShaped`→existing template (a BROADER stem list than invoice — for a statement the totals ARE the D56-gated headline, so `total`/`summe`/`saldo`/`kontostand`/`net change`/`cashflow`/category stay gated; +`\bstimm(en\|t)\b` + `warum`/`why` explanatory guard), else→`{mode:'grounded-data',dataBlock,postscript}` streamed by the handler-agnostic W3 `registerRagIpc` block (untouched). `dataBlock`=`buildStatementDataBlock` (JSON + reconciliation + D56 completeness verdict + deterministic per-category grouping + provenance, capped ~150 rows); `postscript`=`buildCashflowPostscript` (in/out/net verbatim, '' on mixed currency) + the R5 date caveat. Fixed the self-referential `transactionsMore` copy to name the real affordances (run-bar **Export to CSV** button + inline CSV/JSON), and made BOTH CSV intros honest (bank + invoice `formatIntroCsv`, §3.6-low — CSV carries rows/line-items only). Follow-up regression pinned on both handlers ("warum stimmen die Summen nicht?"→grounded-data, not the byte-identical template). NO extractor-version bump (serializers are read-side; extraction output byte-identical). Adversarial 4-lens diff review (each finding independently verified): correctness/D56, plan-conformance, and parity/i18n lenses ALL clean; 3 confirmed test-coverage gaps closed (integration category-grouping assertion, CSV mode-unset, invoice CSV-honesty branch). +16 net-new tests; full suite green (2898) + typecheck. Branched off `fix/skills-w3`. `fix/skills-w4` |
| W5 | One trigger vocabulary + matcher + scoring + 8-skill corpus | P1 | — | L | [ ] |
| U1 | Honest completeness (droppedRowCount + badges + fence trim) | P2 | R2 | M | [ ] |
| U2 | PII detectors: redaction gaps + share-safe pre-pass + dry-run | P2 | — | M | [ ] |
| U3 | Skill-selection UX: per-turn apply + undo + relay pinning | P2 | — | M | [ ] |
| U4 | Auto-fire reach: narrowed signals + skill opt-ins | P2 | W5 | S | [ ] |
| U5 | Copy & i18n sweep + export-dialog metadata | P2 | — | S | [ ] |
| A1 | Parameterized run seam (fold invoice-run into run) | P3 | R3 | L | [ ] |
| A2 | Self-describing tool registry + per-doc run controller | P3 | U5 | L | [ ] |
| A3 | Manifest analysis mode + whole-doc gate inversion | P3 | W1 W2 W5 | L | [ ] |
| T1 | Eval & fixture infrastructure + real-model smoke | P1½ | R1–R2 | M | [ ] |

Recommended order: **R1 → R2 → R3 → R4 → W1 → W2 → W3 → W4 → T1 → W5 → R5 → R6 → U1 → U2 → U3 →
U4 → U5 → A1 → A2 → A3.** R-phases are independent hotfixes (any subset can ship first). T1 can run
any time after R2 and de-risks everything after it.

---

# Track R — P0 correctness (wrong figures/answers)

## R1 — Character normalization + money sign fixes
**Audit:** §5.3 (both bullets), §5.7-low "bare-integer totals fallback drops the sign".
**Files:** `apps/desktop/src/main/services/skills/tools/money.ts`,
`tools/invoice.ts` (only `BARE_INTEGER_RE`/`totalsMoney`, ~:246-285), `tools/bank-statement.ts`
(version const + entry point only), tests: `tests/unit/skills-bank-statement-tool.test.ts`,
`tests/unit/skills-invoice-tool.test.ts`. Check `ingestion/parsers/pdf-layout.ts` `MONEY_TOKEN_RE`
for the same sign/space classes (audit says the geometry path is equally affected).

**Decisions (made):**
- One exported pure function `normalizeExtractionText(s: string): string` in `money.ts`:
  U+2212/U+2013/U+2011 → `-`; NBSP U+00A0 / U+202F / U+2007 → ASCII space; U+2019 → `'`.
  Call it at the **entry points of both extractors** (`extractTransactionRows`, `extractInvoice`)
  and anywhere `MONEY_RE`/`parseAmount` receive raw text, so all downstream regexes see clean text.
  Do NOT change `MONEY_RE` itself for spacing (normalization makes that unnecessary); DO extend
  `pdf-layout.ts` token handling the same way (normalize the reconstructed line before parsing).
- `totalsMoney`'s bare-integer fallback: capture optional leading `-`/`(` and trailing `-` around
  the integer and apply `parseAmount`'s sign rules (a `Gesamtbetrag -914 EUR` credit note must
  read −914).
- Bump BOTH extractor versions by 1.

**Tests to add (execute the real modules):** U+2212 amount reads negative; en-dash trailing minus;
NBSP-grouped `1 234,56` → 1234.56; U+202F; Swiss `1’234.56` → 1234.56; full bank row with NBSP
amounts parses correctly; negative bare-integer labeled total; geometry-path line with U+2212.
**Acceptance:** all new tests green; existing suites green; both versions bumped; no behavior
change for ASCII inputs (existing fixtures byte-identical results).

**Session prompt:**
```
Execute Phase R1 of docs/skills-remediation-plan.md (branch fix/skills-r1).
Read plan §0 (protocol) + §R1, then audit §5.3 and the §5.7 "bare-integer sign" bullet in
docs/skills-audit-2026-07-02.md. Scope: a shared Unicode normalization pre-pass for all money/row
extractors + sign-aware bare-integer totals fallback, with extractor version bumps and regression
tests that execute the real modules. Non-goals: any other parser change, any routing change, any
refactor. Follow the plan's decisions exactly; if code reality contradicts the plan, stop and
report instead of improvising. Finish with the §0 end-of-session ritual.
```

## R2 — Invoice/bank label & totals matching
**Audit:** §5.2 (CRITICAL), §5.4.
**Files:** `tools/invoice.ts` (`NET_LABELS`/`TAX_LABELS`/`GROSS_LABELS` ~:155-170, `labeledValue`
~:209-221, `startsWithAny` ~:223-225, `applyHeader`/`applyTotals`, cascade ~:447-449),
`tools/bank-statement.ts` (`kontostand` handling ~:215, `isBalanceLabelLine` ~:419), tests as R1
plus `tests/integration/skills-analysis-invoice.test.ts`.

**Decisions (made):**
- Label match requires a **structural boundary**: label followed by end-of-word (separator `:`,
  `#`, whitespace-then-figure) — never a bare prefix inside a longer word (`Steuerberatung` must
  NOT match `steuer`).
- A line is a **totals line** only when the remainder after the label is essentially just the
  figure (+currency/%/short filler) — a line that also parses as a money-bearing line item falls
  through to `parseLineItem`. `applyHeader` likewise must never consume a line that parses as a
  line item.
- **Last totals block wins** (replace first-wins): later assignments overwrite, since real invoices
  print the totals block after the items.
- Extend labels: NET += `summe netto`, `nettobetrag`; GROSS += `summe`, `gesamtsumme`, `endsumme`,
  `rechnungssumme`, `endbetrag`, `zahlbetrag` (keep existing); TAX unchanged unless tests demand.
- Add an invoice **summary-line guard** mirroring the bank `isBalanceLabelLine`: a line whose
  description part is ONLY a known summary label never becomes a line item (kills phantom items).
- Bank: recognize `kontostand am`/`kontostand zum` in addition to `kontostand per`.
- Bump `INVOICE_EXTRACTOR_VERSION` (+ bank version if bank matching changed).

**Tests to add:** the audit's probe cases as fixtures — items `Steuerberatung Jänner 500,00 EUR`,
`Netto-Miete Objekt 3 1.000,00 EUR`, `Total hours consulting 40,00 EUR`, `Due diligence review…`
stay line items with correct totals from the real totals block; `Summe 300,00` /
`Rechnungssumme inkl. USt 360,00` / `Endbetrag 360,00` produce totals and ZERO phantom items;
`Kontostand am 31.03.2026 …` yields opening/closing balances. Plus: genuine `Steuer: 60,00` /
`Tax 60,00` totals lines still parse (no regression on boundary-matched labels).
**Acceptance:** probe cases green; all 144+ invoice/bank tests green; version(s) bumped.

**Session prompt:**
```
Execute Phase R2 of docs/skills-remediation-plan.md (branch fix/skills-r2).
Read plan §0 + §R2, then audit §5.2 and §5.4. Scope: structural (word-boundary/separator) label
matching in the invoice extractor, last-totals-block-wins, a summary-line guard against phantom
line items, extended German totals labels, and bank 'Kontostand am/zum' — with extractor version
bumps and the audit's probe inputs as regression fixtures. The CRITICAL bug: 'Steuerberatung
Jänner 500,00 EUR' currently becomes taxTotal. Non-goals: money regex changes (R1 owns those),
description cleanup (R6), any routing/answer change. Follow the plan's decisions exactly; stop and
report if code reality contradicts them. Finish with the §0 ritual.
```

## R3 — Stale-row runs + sepa prefilter demotion
**Audit:** §5.6, §5.5.
**Files:** `services/skills/run.ts` (`prepareStatementRun` ~:495-566), `invoice-run.ts`
(`prepareInvoiceRun` ~:346-415), `tools/bank-statement.ts` (`BUILTIN_CATEGORY_RULES` ~:693),
`categorizer.ts` (`prefilterCategory` ~:149-168), tests: `tests/integration/skills-run.test.ts`,
`tests/unit/skills-categorizer.test.ts`.

**Decisions (made):**
- `prepareStatementRun`/`prepareInvoiceRun`: when the latest extraction is stale
  (`isBankStatementStale`/`isInvoiceStale`), **re-extract with `replaceExisting: true`** before the
  downstream tool runs (parity with the analysis-handler path) — for read-only AND export tools.
  If re-extraction fails, fail the run with the existing `needsExtraction` error code.
- `sepa` rule: **remove it from the confident prefilter set**. Concretely: keep
  `{category:'Transfer', pattern:'sepa'}` available to `categorizeRow` as the no-model fallback,
  but `prefilterCategory` must NOT treat a match on transfer-boilerplate patterns (`sepa`, and
  audit-flagged `überweisung`) as confident — those rows go to the model when a runtime is loaded.
  Introduce a `confident: false` flag on rules rather than deleting them.

**Tests to add:** stale statement + Validate/Summarize/Export runs → rows are re-extracted (new
extraction id, version = current) before output; stale invoice + JSON export → same; fresh rows are
NOT re-extracted (no duplicate); `SEPA-Lastschrift NETFLIX…` / `SEPA-Dauerauftrag Miete…` reach the
model path in the categorizer prefilter test (and still get 'Transfer' from `categorizeRow` when no
runtime).
**Acceptance:** all listed suites green; no change to run lifecycle events/audit shape.

**Session prompt:**
```
Execute Phase R3 of docs/skills-remediation-plan.md (branch fix/skills-r3).
Read plan §0 + §R3, then audit §5.6 and §5.5. Scope: staleness-aware re-extraction in
prepareStatementRun/prepareInvoiceRun (run-bar buttons and exports must never serve rows from an
outdated extractor), and demoting transfer-boilerplate categorizer rules ('sepa', 'überweisung')
from confident-prefilter to no-model-fallback so the LLM categorizer sees those rows. Non-goals:
the run-seam refactor (A1), any answer/template change. Follow the plan's decisions exactly; stop
and report on contradiction. Finish with the §0 ritual.
```

## R4 — Deterministic compare pair + scope-query consolidation
**Audit:** §5.1, §4.6.
**Files:** `ipc/registerRagIpc.ts` (private `documentsInScope` ~:33-45 and its four use sites
~:181,:239,:271,:341), `services/skills/analysis/redaction.ts` (private copy ~:49-60),
`services/skills/scope-documents.ts` (shared helper), `services/rag/index.ts` (compare labels/
prompts: `[idA,idB]` ~:568, attribution ~:627-630, `buildCompareDiffPrompt` ~:809-813,
`buildCompareWholeDocPrompt` ~:768-789), tests: `tests/integration/rag-whole-doc-compare.test.ts`,
`whole-doc-compare.test.ts`, `skills-analysis-redaction.test.ts`.

**Decisions (made):**
- Delete BOTH private scope queries; route through
  `documentsInScope(db, scope, { requireChunks: true })` (project ids/titles locally). This gives
  the compare pair the shared helper's deterministic `ORDER BY created_at, id`.
- **Stop asserting old/new.** Compare prompts present the pair as "Document A: «title» (imported
  <date>)" / "Document B: «title» (imported <date>)" and describe the diff as "differences between
  A and B" with additions/removals attributed relative to A→B — never "old version"/"new version".
  The SKILL.md `what-changed` body: adjust any old/new phrasing to match (keep the honesty rules).
- Add a **grep test** asserting the SQL pattern `FROM documents d` + `status = 'indexed'` appears
  only in `scope-documents.ts` (audit §4.6's recommendation).

**Tests to add/adjust:** compare pair order is deterministic (created_at,id) regardless of
insertion order in the test db; prompts contain both titles and no "old version"/"new version"
assertion; existing compare-mode tests updated to the new wording; grep test.
**Acceptance:** compare suites green; redaction handler behavior unchanged (same docs resolved).

**Session prompt:**
```
Execute Phase R4 of docs/skills-remediation-plan.md (branch fix/skills-r4).
Read plan §0 + §R4, then audit §5.1 and §4.6. Scope: delete the two private in-scope-document
queries (registerRagIpc.ts, analysis/redaction.ts) in favor of the shared ordered helper, make the
what-changed compare direction honest (label documents by title + import date, never assert
old→new), and add a grep test preventing future private copies. The bug: compare direction is
currently unspecified SQL row order asserted to the model as exact fact — reports can be exactly
inverted. Non-goals: diff algorithm changes, compare budget changes (W1). Follow the plan's
decisions exactly. Finish with the §0 ritual.
```

## R5 — Date correctness
**Audit:** §5.7 bullets: dd.mm.yy zero-rows; cross-year page stamping; §5.7-low ambiguous-date
silent day-first.
**Files:** `tools/money.ts` (`parseDate` ~:264-283, `splitLeadingDates` ~:310-323,
`inferDateOrder` ~:238-262), `ingestion/parsers/pdf-layout.ts` (`toFullDate` ~:162-179,
`resolvePageYear` ~:452-460), `tools/bank-statement.ts` + `tools/invoice.ts` (plumb a flag),
analysis answer templates (one caveat line), `shared/i18n/en.ts`+`de.ts`, tests:
`skills-bank-statement-tool.test.ts`, `pdf-bank-layout.test.ts`, `skills-analysis-bank.test.ts`.

**Decisions (made):**
- Port the geometry path's century expansion to `parseDate`: accept `d.m.yy` **only when the
  document provides a year anchor** (any fully-printed 4-digit-year date in the same document →
  expand into that century window), else keep dropping (drop-don't-guess stands).
- Cross-year: month-rollover — when a bare date's month is ≥ 11 and the page/period anchor month is
  ≤ 2 (or vice versa), assign year∓1. Apply in `toFullDate` (geometry) and the new `parseDate`
  anchor path symmetrically.
- Ambiguous-date honesty (additive schema): persist `date_order_inferred TEXT` ('evidence' |
  'default') on `bank_statements` and `invoices`; when 'default' AND at least one dotted/slashed
  date was parsed, the deterministic answers append one localized caveat line ("dates read
  day-first; the document gave no evidence either way"). No per-row channel (schema frozen —
  respected).
- Bump both extractor versions.

**Tests to add:** dd.mm.yy CSV statement with a 4-digit anchor extracts all rows with correct
years; without any anchor still extracts zero (posture preserved) — assert explicitly; January
statement with `28.12.` row gets previous year (geometry + plain paths); all-ambiguous US doc
answer carries the caveat line (en + de); evidence docs carry none.
**Acceptance:** listed suites green; schema change additive; versions bumped.

**Session prompt:**
```
Execute Phase R5 of docs/skills-remediation-plan.md (branch fix/skills-r5).
Read plan §0 + §R5, then audit §5.7 (the three date bullets). Scope: anchor-gated two-digit-year
expansion in parseDate (port of the geometry path's approach), month-rollover for cross-year
statements on both paths, and an additive date_order_inferred flag surfaced as one honest caveat
line in the deterministic answers (en+de, du-form). Extractor version bumps. Non-goals: any other
parser change; redaction date masking (U2). Follow the plan's decisions exactly. Finish with the
§0 ritual.
```

## R6 — Row fidelity: wrapped descriptions + line-item column debris
**Audit:** §5.7 bullets: wrapped/multi-line descriptions dropped; line-item column debris +
quantity/unitPrice misassignment.
**Files:** `tools/bank-statement.ts` (`extractTransactionRows` ~:415-429, `parseLine` ~:139-157),
`tools/invoice.ts` (`parseLineItem` ~:375-420, description slice ~:394, `QTY_TRAIL_RE` ~:177),
tests: both tool suites + `skills-analysis-invoice.test.ts` (listing shows clean descriptions).

**Decisions (made):**
- Plain-path continuation rule (mirror of the geometry association): a line with **no leading date
  and no money token** that directly follows a parsed row is appended to that row's description
  (single continuation max — bounded, mirroring `MAX_CONTINUATION_ROWS`); same rule for invoices
  (no leading money and not a label/summary line).
- Invoice description cleanup, deterministic and reversible-safe: strip ONE leading standalone
  integer (row index) into a `rowIndex`-ish ignore (do not persist a wrong quantity from it);
  strip a trailing `<int> <int>%` or `<int> <pct>%` run — assign the int to `quantity` and the pct
  to a new optional `taxRatePercent` on the line item ONLY when the remaining money tokens fit the
  `quantity × unitPrice ≈ lineTotal` identity; otherwise leave description intact (drop-don't-guess).
- Bump both versions.

**Tests to add:** the audit probe `1 Web hosting 12 Monate 1 0% 76,17 914,00` → description
`Web hosting 12 Monate`, quantity 1, unitPrice 76.17 REJECTED by the identity check (76.17×1 ≠ 914)
→ description kept safe per the rule above — construct BOTH a passing identity case and this
failing one and assert each behavior; CSV statement with wrapped `SEPA-Lastschrift` +
`NETFLIX INTERNATIONAL…` second line → description contains NETFLIX; continuation is bounded (a
third dateless line does not glue).
**Acceptance:** listed suites green; exports (JSON/CSV/XML) carry the cleaned shapes; versions
bumped.

**Session prompt:**
```
Execute Phase R6 of docs/skills-remediation-plan.md (branch fix/skills-r6).
Read plan §0 + §R6, then audit §5.7 (wrapped-description and column-debris bullets). Scope:
bounded continuation-line association on the plain text/CSV paths (bank + invoice), and
identity-checked cleanup of invoice line items (leading row index, trailing qty/tax-rate columns)
so the JSON/CSV/XML exports carry clean structured rows. Keep drop-don't-guess: any cleanup that
cannot be verified by the quantity×unitPrice≈lineTotal identity leaves the description as-is.
Extractor version bumps. Non-goals: geometry-path changes, new column model (F10 stays open).
Follow the plan's decisions exactly. Finish with the §0 ritual.
```

---

# Track W — P1 complaint drivers

## W1 — Whole-doc budget honesty
**Audit:** §2.2 (ALL bullets: prefix read + no notice; German 1.5 divisor; 80-token de-overlap;
tree stamp + map ceiling; compare-fallback notice), plus §7 rec 4 (truncation regression suite).
**Files:** `services/rag/index.ts` (grep: `retrieveWholeDocument`, `wholeDocumentBudgetTokens`,
`RETRIEVAL_FIT_SAFETY`, `retrieveCompareWholeDocuments`, `buildCompareWholeDocPrompt`,
`splitCompareBudget`, `documentApproxTokenTotal` — read those ranges only),
`services/rag/whole-doc-tree.ts` (notes truncation ~:177, coverage ~:121-128, map loop ~:167-169),
`services/doctasks/summary.ts` (`SUMMARY_MAP_CALL_CEILING` — reuse), i18n, tests:
`rag-whole-doc-skill.test.ts`, `rag-whole-doc-tree.test.ts`, `rag-whole-doc-compare.test.ts`.

**Decisions (made):**
- **In-prompt truncation notice:** when `retrieveWholeDocument` (or a compare half) truncates, the
  grounded prompt states: sections 1–N of M provided, the rest NOT provided; instruct the model to
  say its answer covers only the beginning and to never assert an absence ("no decisions found")
  beyond the provided sections. Fixed English app-authored text (D-L6 precedent), rides with the
  excerpts.
- Apply `RETRIEVAL_FIT_SAFETY` (1.5) to `wholeDocumentBudgetTokens` and the compare split (divide
  the budget, mirroring `retrievalExcerptBudgetTokens`).
- **De-overlap:** when concatenating consecutive chunks, strip the known ~80-token
  (`chunkOverlapTokens`) overlap using chunk metadata; count de-overlapped text against the budget;
  fix `documentApproxTokenTotal` the same way for the compare split inputs.
- Tree path: propagate notes-truncation into the coverage stamp (`truncated: true`) + soften the
  reduce prompt when it fires; add a map-call ceiling reusing `SUMMARY_MAP_CALL_CEILING` semantics
  with honest truncated marking.
- **Truncation regression suite:** a realistic ~10-page German-ish fixture at contextTokens=4096
  asserting: truncation flagged, notice present in the prompt (capture via mock runtime), budget
  ≤ (4096 − reserves)/1.5, no overlap duplication in the assembled text.

**Acceptance:** listed suites green (existing fixtures may need coverage-expectation updates —
adjust ONLY expectations that asserted the dishonest behavior, and say so); no answer-path
regression for small (non-truncating) docs.

**Session prompt:**
```
Execute Phase W1 of docs/skills-remediation-plan.md (branch fix/skills-w1).
Read plan §0 + §W1, then audit §2.2 (all bullets). Scope: make whole-document reads honest and
safe at the default 4096 context — in-prompt truncation notice (model is TOLD what it cannot see
and must not assert absences), the 1.5 German-subword safety divisor on whole-doc + compare
budgets, de-overlapping the 80-token chunk overlap, tree-path truncation propagated into the
coverage stamp + a map-call ceiling, and a truncation regression suite at realistic document sizes.
Read rag/index.ts ONLY at the greppable symbols listed in the plan — never the whole file.
Non-goals: routing changes (W2), gate inversion (A3), deep-index auto-build (note as follow-up).
Follow the plan's decisions exactly. Finish with the §0 ritual.
```

## W2 — Doc-count fallthrough routing + plausibility gate
**Audit:** §2.1 (CRITICAL), §3.4 (what-changed routing half), §4.5.
**Files:** `ipc/registerRagIpc.ts` (handler block ~:195-331 — grep `getSkillAnalysisHandler`),
`services/skills/analysis/whole-doc-skills.ts`, `analysis/bank-statement.ts` + `analysis/invoice.ts`
(`applies()`), `analysis/types.ts` (if a new result kind is needed), i18n en+de, tests:
`rag-skill-analysis.test.ts`, `rag-skill-analysis-invoice.test.ts`, `skills-analysis-whole-doc.test.ts`.

**Decisions (made):**
- New behavior when the turn skill HAS a handler and the question is intent-shaped but `applies()`
  fails **only on document count**:
  1. Try to **narrow to one document** using the skill's own manifest doc signals
     (filenamePatterns/mimeTypes) over the in-scope set; if EXACTLY ONE candidate matches, proceed
     against it and prepend a localized scope notice to the answer ("answered from «title» — the
     other N documents in scope were not read; narrow the scope to change this"). The filename
     auto-scope (~registerRagIpc:180-193) is the precedent — reuse its plumbing where possible.
  2. Otherwise emit a **deterministic routing answer** (mode 'routing' precedent): "pick one
     statement/invoice/document to analyse fully — right now I can only see excerpts" (en+de, du).
- `what-changed` ≠ 2 docs + compare-shaped question → deterministic routing answer ("select
  exactly two documents/versions to compare"), replacing the SKILL.md's ask-the-model policing
  (adjust that SKILL.md paragraph; the model cannot see the scope).
- **Plausibility gate (§4.5):** in bank/invoice `run()`, when extraction yields ZERO rows AND the
  document matches none of the skill's manifest doc signals, do NOT emit the empty template —
  return a fall-through result so the turn takes the ordinary grounded path (the LLM answers the
  actual question). Zero rows on a doc that DOES look like a statement/invoice keeps the honest
  empty answer.
- Keep it deterministic: no new model calls in this phase.

**Tests:** 3-doc scope + "summarize my bank statement" with skill active → narrowed to the one
`*statement*` doc + notice, or routing answer when ambiguous — both cases; what-changed with 1 and
3 docs → deterministic message; sticky bank skill + contract-only scope + "give me a summary" →
grounded path (no "no transactions" nonsense); single-statement happy path byte-unchanged.
**Acceptance:** no silent fallthrough remains for intent-shaped questions with a doc-count-only
failure; suites green.

**Session prompt:**
```
Execute Phase W2 of docs/skills-remediation-plan.md (branch fix/skills-w2).
Read plan §0 + §W2, then audit §2.1, §3.4, §4.5. Scope: kill the silent doc-count fallthrough —
narrow to the skill's best-matching document (manifest doc signals; reuse the filename auto-scope
plumbing) with an honest scope notice, or answer with a deterministic routing message; a
deterministic 'select exactly two documents' answer for what-changed at ≠2 docs (and fix its
SKILL.md, which currently asks the model to police scope it cannot see); and a document-
plausibility gate so a zero-row extraction on a non-matching document falls through to the
grounded path instead of claiming 'no transactions'. All deterministic — zero new model calls.
Non-goals: whole-doc budget internals (W1), keyword lists (W5), gate inversion (A3). Follow the
plan's decisions exactly. Finish with the §0 ritual.
```

## W3 — Third mode (LLM over extracted, verified data) — seam + invoice
**Audit:** §8.1 (design), §3.1 (defect). This is the highest-leverage phase.
**Files:** `services/skills/analysis/types.ts` (+ new result mode), `analysis/invoice.ts`,
`ipc/registerRagIpc.ts` (exhaustive branch ~:297-331 gains a streamed variant),
`services/rag/index.ts` OR `services/rag/grounded-data.ts` (new small prompt builder — prefer a new
file), `tools/invoice.ts` (`buildInvoiceJson` reuse), i18n, tests:
`rag-skill-analysis-invoice.test.ts` + a new `grounded-data` unit test.

**Decisions (made):**
- New handler outcome: alongside the deterministic answer, `run()` may return
  `{ mode: 'grounded-data', dataBlock, citations, coverage }` where `dataBlock` is the serialized
  verified object: `buildInvoiceJson(invoice)` + validation results + a one-line provenance note.
  `registerRagIpc` streams a model answer over a new `buildGroundedDataPrompt(question, dataBlock,
  skillFence?)`: fixed rules — answer ONLY from the data block; quote figures verbatim (no
  arithmetic, no derived numbers not present); if the data block lacks the asked fact, say the
  extraction does not carry it; answer in the user's language. Fence placement mirrors
  `buildGroundedPrompt` (skill fence in the user turn).
- **Question-shape routing inside the invoice handler:**
  - format-shaped (`detectFormat`) → serializer (unchanged);
  - summary-shaped (explicit narrow list: `summar`/`überblick`/`overview`/`zusammenfass`/
    `reconcile`/`stimmen`/`aufstellung`/`list the items`/`positionen auflisten`… define ~10 stems)
    → the existing deterministic template (keep — high-stakes shape);
  - **anything else that passed `applies()` → grounded-data** (the new default).
- Template fix regardless of routing: `buildInvoiceAnswer` gains the loaded header fields (vendor,
  invoice number, invoice date, due date) as a small "Details" block — the "who is the vendor"
  template gap dies even on the template path.
- Deterministic figure echo (audit §8.1 caveat): under every grounded-data answer, append the
  compact deterministic totals line (net/tax/gross as parsed) as a non-model postscript so a model
  misquote is visibly contradicted. Cheap, honest, zero risk.
- The 4096-ctx guard: `dataBlock` is capped (line items beyond ~150 rows summarized to
  "…and N more rows"; totals/header always included) and pre-sized against the context like the
  skill fence is.
- Mock-runtime integration test asserts: the prompt contains the JSON block and the verbatim-quote
  rule; a vendor question routes to grounded-data (not template); a "summarize" ask still gets the
  template; the postscript totals line matches the parsed totals.

**SPLIT-POINT:** if context runs long, land the seam + invoice handler + tests and STOP (bank is
W4). Do not start the bank port.
**Acceptance:** vendor/due-date/tax-ID-class questions produce model answers over the data block;
summary/format behavior unchanged; figure postscript present; suites green.

**Session prompt:**
```
Execute Phase W3 of docs/skills-remediation-plan.md (branch fix/skills-w3).
Read plan §0 + §W3, then audit §3.1 and §8.1. Scope: build the missing third answer mode — a
'grounded-data' handler outcome that streams an LLM answer over the serialized, deterministically
extracted + validated invoice object (buildInvoiceJson + validation), with strict
quote-figures-verbatim rules and a deterministic totals postscript under every model answer.
Route inside the invoice handler: format asks → serializer (unchanged); a narrow summary-shaped
list → the existing template (unchanged); everything else that passes applies() → grounded-data.
Also add the loaded header fields (vendor, invoice number, dates) to the deterministic template.
The LLM must never compute a figure — it narrates parsed data only. Respect the SPLIT-POINT: the
bank port is W4, do not start it. Follow the plan's decisions exactly. Finish with the §0 ritual.
```

## W4 — Third mode: bank port + format parity + follow-up behavior
**Audit:** §3.1 (bank half), §3.3, §3.6-low (CSV intro note), "byte-identical follow-ups"
(§3.1/§3.6 context).
**Files:** `analysis/bank-statement.ts`, `tools/bank-statement.ts` (serializers — add
`buildStatementJson` mirroring invoice; CSV exists), i18n (fix `transactionsMore` copy
~en.ts:584-585 + de twin; CSV-intro caveat), tests: `skills-analysis-bank.test.ts` + serializer
units.

**Decisions (made):**
- Port W3's routing to the bank handler: format-shaped → NEW inline JSON/CSV serialization of the
  persisted rows (`detectFormat` port; JSON carries rows + summary + balances; CSV reuses the
  export serializer); summary-shaped → existing template; else → grounded-data over
  `{rows (capped), cashflow summary, reconcile result, categories}` with the same verbatim rules +
  deterministic in/out/net postscript.
- Fix the self-referential copy: `transactionsMore` now points at the run-bar **Export** button by
  its actual label for a saved file, and mentions "as CSV/JSON here in chat" for the inline path.
- Invoice CSV intro (§3.6-low): state that CSV carries line items only and JSON/XML carry
  header+totals (en+de).
- Follow-ups: with W3/W4 routing, non-summary follow-ups ("warum stimmen die Summen nicht?")
  naturally hit grounded-data — add a test asserting a repeat-intercept question produces a
  DIFFERENT (model) answer, not the byte-identical template.

**Acceptance:** bank format asks render inline; grounded-data path live for bank; copy fixed en+de;
suites green.

**Session prompt:**
```
Execute Phase W4 of docs/skills-remediation-plan.md (branch fix/skills-w4).
Read plan §0 + §W4, then audit §3.1, §3.3 and the §3.6 CSV-intro bullet. Prerequisite: W3 landed
the grounded-data seam — read its diff (git log fix/skills-w3 or master) before coding. Scope:
port question-shape routing + grounded-data to the bank handler, add inline JSON/CSV for bank
(detectFormat port + a buildStatementJson serializer), fix the self-referential 'ask me to export'
copy to name the real affordances, honest invoice CSV intro, and a regression test that follow-up
questions no longer get the byte-identical template. LLM narrates parsed figures only —
deterministic in/out/net postscript under model answers. Follow the plan's decisions exactly.
Finish with the §0 ritual.
```

## W5 — One trigger vocabulary + matcher + scoring + 8-skill corpus
**Audit:** §8.3, §3.2, §4.1, §4.2, §6.4 (corpus bullet), §7 recs 3.
**Files:** NEW `services/skills/vocabulary.ts` (canonical per-skill bilingual vocab), all 8
`app-skills/*/SKILL.md` trigger blocks, `analysis/bank-statement.ts` / `analysis/invoice.ts` /
`analysis/whole-doc-skills.ts` / `analysis/redaction.ts` (consume vocabulary), `selector.ts`
(matcher + scoring), `tools/money.ts` (`wordIncludes` — export/reuse), eval:
`tests/eval/skill-triggers.ts` (+`APP_SKILL_IDS`), `tests/fixtures/skill-triggers/corpus.json`,
tests: `skills-selector.test.ts`, `skills-suggest.test.ts`, `skills-skillmd-parity.test.ts`.

**Decisions (made):**
- **Canonical vocabulary in code** (`vocabulary.ts`): per skill, entries
  `{ term, lang: 'en'|'de', match: 'word'|'phrase'|'stem', use: 'suggest'|'route'|'both' }`.
  Routing gates (`isAnalysisShaped`, whole-doc keyword lists) consume `route|both` entries via
  `wordIncludes` for `word`, substring for `phrase`/`stem`. SKILL.md `triggers.keywords` stay (the
  manifest format is public) but a **parity test** asserts every manifest keyword equals a
  `suggest|both` vocabulary entry and vice versa — regenerate the SKILL.md lists from the
  vocabulary in this phase and keep them in sync by test.
- **Kill the bare-token over-fires:** remove/rebind `net`, `sum`, `tax`, `bill`, `total`,
  `position`, `statement`, `minutes`, `meeting`, `balance`, `transaction`, `agenda`, `änderungen`,
  `vergleich` … as WORD-matched (not substring) or phrase-bound entries. Add the incident-list
  under-fire terms: `gesamtwert`, `summarize this meeting`-class stems (`summariz` + `meeting`
  co-occurrence is acceptable as two word-matched terms), `strukturiere`, etc.
- **Scoring (selector.ts):** suggestion requires ≥1 keyword hit (doc signals become
  supporting-only); keyword contribution capped at `min(hits,2)×2`; overlap dedupe —
  longest-match-wins so `meeting minutes` counts once; keep deterministic tie-break.
- **Corpus:** extend to all 8 skills, ≥80 items, German paraphrases, cross-skill confusion pairs
  (contract vs deadline vs what-changed; bank vs invoice), multi-doc scope shapes. Add an asserted
  bar for the SUGGESTION policy: `fired-wrong == 0` on the confusion set and precision ≥ 0.80
  overall (raise later; document the measured number in BUILD_STATE).
- Handler-vocab drift test: every `route` entry actually routes (call `applies()` with a synthetic
  question embedding the term), asserting suggest→route parity end-to-end.

**SPLIT-POINT:** matcher + scoring + vocabulary module + parity test first; corpus expansion +
bars second. If long, stop after the first half with the old corpus still green.
**Acceptance:** eval harness prints ≥0.80 precision at the suggestion threshold on the new corpus;
"Wie kündige ich mein Netflix-Abo?" no longer intercepted (word-boundary test); "Summarize this
meeting" routes whole-doc; all skills suites green.

**Session prompt:**
```
Execute Phase W5 of docs/skills-remediation-plan.md (branch fix/skills-w5).
Read plan §0 + §W5, then audit §3.2, §4.1, §4.2, §8.3. Scope: one canonical bilingual trigger
vocabulary per skill in code (vocabulary.ts) consumed by BOTH the suggestion manifests (regenerated
SKILL.md keyword lists + parity test) and the routing gates (word-boundary matching via
wordIncludes for single words); fix suggestion scoring (require ≥1 keyword, cap hit contribution,
longest-match dedupe); expand the trigger eval corpus to all 8 skills with German paraphrases and
cross-skill confusion pairs, and assert a precision bar on the SUGGESTION threshold (≥0.80,
fired-wrong 0 on confusion pairs). Known reproductions to kill: 'Netflix'→'net' interception,
'Summarize this meeting' routing miss, 'in 10 minutes'→Meeting offer. Respect the SPLIT-POINT.
Follow the plan's decisions exactly. Finish with the §0 ritual.
```

---

# Track U — P2 reach & trust

## U1 — Honest completeness: droppedRowCount + badges + fence trimming
**Audit:** §2.3, ux-10 + ux-11 (in audit §5.7 context / §2.3), §3.6 fence-trimming bullet.
**Files:** `tools/bank-statement.ts` + `tools/invoice.ts` (count rejected money-bearing lines),
schema (additive `dropped_row_count` on `bank_statements`/`invoices`), `analysis/*.ts` answer
gating, `shared/i18n` (count-line variants, empty-answer copy), `services/skills/prompt.ts`
(`buildSkillFence` ~:140-147 + call sites `chat.ts` ~:1292, `rag/index.ts` ~:1136), all 8
`app-skills/*/SKILL.md` (move honesty/safety rules to the FIRST paragraphs), coverage badge copy
(`en.ts` ~:490), tests: tool suites + `skills-prompt.test.ts` + analysis suites.

**Decisions (made):** count candidate lines (containing a money-shaped token post-normalization)
the parser rejected; persist additively; when >0 the answers replace "the whole invoice/statement"
phrasing with "N read; M lines with figures could not be parsed"; extend the currency-adjacent
integer read to bank balance lines (`lastMoneyOnLine`) closing the §2.3 gate gap; soften the
extract badge ("read across the whole document — N sections scanned"); gate the bank count line on
the D56 status (contradicted ⇒ "…but the printed balances don't add up"); empty-answer copy blames
the reader not the document + names the next step (OCR hint if no text layer, else "this layout may
not be machine-readable"); `buildSkillFence` keeps FIRST paragraphs but bodies are reordered so
honesty rules lead; the `trimmed`/`omitted` flags are logged (ids/counts only) and surfaced as a
coverage-meter hint. Bump extractor versions (counting changes extraction output).

**Session prompt:**
```
Execute Phase U1 of docs/skills-remediation-plan.md (branch fix/skills-u1).
Read plan §0 + §U1, then audit §2.3, the ux-10/ux-11 copy findings (§5.7/§2.3 context) and the
§3.6 fence-trimming bullet. Scope: persist a droppedRowCount per extraction (additive schema) and
gate every 'whole document' claim on it; extend the currency-adjacent bare-integer read to bank
balance lines; soften the 'Every match found' badge; fix the self-contradicting contradicted-case
answer and the dead-end empty-extraction copy (en+de, du-form); reorder all 8 SKILL.md bodies so
honesty/safety rules are in the first paragraphs and log the fence trimmed/omitted flags instead
of discarding them. Extractor version bumps. Follow the plan's decisions exactly. Finish with the
§0 ritual.
```

## U2 — PII detectors: redaction gaps + share-safe pre-pass + dry-run
**Audit:** §5.7 redaction bullet, §3.5, §3.4 (redaction dry-run half).
**Files:** `tools/redaction.ts` (~273 lines — read fully), `analysis/redaction.ts`,
`ipc/registerRagIpc.ts` (share-safe whole-doc branch feeds the pre-pass — grep), i18n, tests:
`skills-redaction-tool.test.ts`, `skills-analysis-redaction.test.ts`.

**Decisions (made):** add a Luhn-validated 13–19-digit card detector (masked before phones; spaced/
dashed/compact groupings); fix the 0-leading phone branch (require phone context or exclude ≥9-digit
separator-less runs — reference numbers); mask date candidates that parse in EITHER order (over-
masking dates is fine for redaction, unlike extraction); expose a read-only
`scanRedactionCandidates(text) → counts per category`; redaction handler gains an **informational
dry-run branch**: information-shaped questions ("welche personenbezogenen daten…", "what personal
data…") get "a whole-document scan found N e-mails, M IBANs, K phone numbers… — the «Redact»
button creates the masked copy" instead of the button deflection (counts only — no PII content in
the answer beyond counts); share-safe whole-doc prompt gets the deterministic scan summary injected
and the "Likely low risk" verdict string is gated on non-truncated coverage (SKILL.md wording +
prompt rule).

**Session prompt:**
```
Execute Phase U2 of docs/skills-remediation-plan.md (branch fix/skills-u2).
Read plan §0 + §U2, then audit the §5.7 redaction bullet, §3.5 and §3.4. Scope: Luhn-checked card
detector, fixed 0-leading phone false positives, either-order date masking; a read-only
scanRedactionCandidates(counts) used twice — an informational dry-run answer in the redaction
handler (counts only, never PII content) and a deterministic whole-document scan summary injected
into the share-safe-review prompt, with the 'Likely low risk' verdict gated on non-truncated
coverage. Follow the plan's decisions exactly. Finish with the §0 ritual.
```

## U3 — Skill-selection UX: per-turn apply + undo + relay pinning
**Audit:** §4.3, ux-6.
**Files:** `renderer/screens/ChatScreen.tsx` (`selectSkill` ~:727-737, routed-run effect ~:906-928,
undo gating ~:1066-1078), `renderer/chat/SkillPicker.tsx`, `services/skills/turn.ts`,
`ipc/registerChatIpc.ts` / `registerRagIpc.ts` (scope pin plumbing), i18n, tests:
`renderer/SkillRunBar.test.tsx` area + `skills-turn.test.ts` + `skills-ipc.test.ts`.

**Decisions (made):** a picker pick applies **per-turn by default**; the picker gains a
"keep for this conversation" toggle that persists the sticky default (explicit, not implicit);
existing sticky defaults keep working; a persistent composer chip shows the active skill with an ×
(clears override AND sticky); the "answer without this skill" regenerate affordance extends to ALL
skill-stamped answers (not only auto-fired); the routed-run relay (Summarize/Categorize buttons)
passes the run's `documentId` so `askDocuments` pins scope to that document (kills the multi-doc
wrong-scope answer), and the two buttons are hidden in plain-chat mode (where their output is
unreachable). Renderer tests cover: per-turn default, keep-toggle, chip ×, undo on manual turns,
relay pinning.

**Session prompt:**
```
Execute Phase U3 of docs/skills-remediation-plan.md (branch fix/skills-u3).
Read plan §0 + §U3, then audit §4.3 and the ux-6 finding (§6-adjacent, 'Summarize/Categorize
button results break outside the single-doc happy path'). Scope: per-turn skill application with
an explicit keep-for-conversation toggle, a persistent composer chip with ×, 'answer without this
skill' extended to all skill-stamped answers, and the routed-run relay pinned to the run's
documentId (plus hiding the two routed buttons in plain-chat mode). Renderer + turn-resolution
changes only — no routing-engine changes. Follow the plan's decisions exactly. Finish with the §0
ritual.
```

## U4 — Auto-fire reach: narrowed signals + skill opt-ins
**Audit:** §2.4, §4.4. **Depends on W5 (measured vocabulary) — do not run before it.**
**Files:** `services/skills/scope-signals.ts`, `autofire.ts`, `app-skills/bank-statement|invoice|
meeting-protocol/SKILL.md` (+ redaction manifest vocab alignment), eval corpus (auto-fire cases),
tests: `skills-autofire.test.ts`, `tests/eval/skill-triggers.test.ts`.

**Decisions (made):** auto-fire doc signals compute over the **narrowed** scope only (chat
attachments / explicit doc selection; a whole-corpus scope contributes NO doc signal); redaction
manifest keywords align with its handler set (drop `gdpr`/`dsgvo`/`datenschutz` from autoFire-
eligible triggers or add informational handling — take the drop); opt `bank-statement`, `invoice`,
`meeting-protocol` into `triggers.autoFire: true`; re-run the eval — the auto-fire threshold must
hold `fired-wrong == 0` AND precision ≥ 0.95 on the EXPANDED corpus including whole-corpus-scope
items; the user setting stays **default-off** (owner may flip later; S13c undo already exists).
Document the measured numbers in BUILD_STATE.

**Session prompt:**
```
Execute Phase U4 of docs/skills-remediation-plan.md (branch fix/skills-u4).
Prerequisite: W5 must be merged (canonical vocabulary + expanded corpus) — verify before starting.
Read plan §0 + §U4, then audit §2.4 and §4.4. Scope: narrow auto-fire doc signals to explicitly
scoped documents (whole-corpus contributes nothing), align the redaction manifest with its handler
vocabulary, opt bank-statement/invoice/meeting-protocol into triggers.autoFire, and prove the
auto-fire gate still holds fired-wrong==0 and precision ≥0.95 on the expanded corpus (including
whole-corpus scope shapes). The setting stays default-off. Follow the plan's decisions exactly.
Finish with the §0 ritual.
```

## U5 — Copy & i18n sweep + export-dialog metadata
**Audit:** ux-12 (du/Sie), ux-15, ux-16, ux-17, §3.6-low (one-blob notice), §6.2 (dialog part only).
**Files:** `shared/i18n/de.ts` (+`en.ts` where wording changes), `ipc/registerSkillsIpc.ts`
(`saveTextFile` ~:67-78), `services/skills/tool-runs.ts` + `invoice-run.ts` (dialog metadata
plumb), `analysis/invoice.ts` (citations stopgap ~:159-173), `ipc/registerRagIpc.ts` (progress
notice ~:303-318), tests: `skill-i18n.test.ts`, `skills-tool-run-ipc.test.ts`.

**Decisions (made):** sweep ALL assistant-voice skill strings in `de.ts` to **du** + add a lint-ish
test flagging ` Sie ` in `skills.*Analysis.*`/routing-answer keys; fix `needsExtraction` copy to
name the actual button label (interpolate it, the redaction pattern); fix the three
"tools run only when you start them" copies to "read-only tools may also run automatically to
answer your question; anything that writes or exports always asks first" (settings note, bank
SKILL.md, user-guide.md); `saveTextFile` gains `{dialogTitleKey, filterName, extensions}` params
supplied per tool (JSON→`.json`, XML→`.xml`, redaction→"Save redacted copy" `.txt`) — targeted fix
now, A2 derives it from the registry later; invoice citations stopgap: include the LAST chunks
alongside the first when the doc exceeds MAX_CITATIONS; send an ephemeral status notice when an
exhaustive-handler run starts (compaction-notice channel precedent).

**Session prompt:**
```
Execute Phase U5 of docs/skills-remediation-plan.md (branch fix/skills-u5).
Read plan §0 + §U5, then audit findings ux-12/15/16/17, the §3.6 one-blob bullet and the dialog
paragraph of §6.2. Scope: German du/Sie consistency sweep for all skill assistant-voice strings
(+ guard test); needsExtraction copy interpolating the real button label; honest 'tools may
auto-run read-only' copy in the three places that claim otherwise; per-tool save-dialog metadata
(titles/filters for JSON/XML/redacted exports); last-chunks citation stopgap for long invoices;
and an ephemeral 'working on it' notice when an exhaustive handler starts a long extraction.
Copy/metadata only — no engine changes. Follow the plan's decisions exactly. Finish with the §0
ritual.
```

---

# Track A — P3 architecture (pay-down for skill №9)

## A1 — Parameterized run seam
**Audit:** §6.1, plus the plumbing bullet of §6.4.
**Files:** `services/skills/run.ts`, `invoice-run.ts` (goal: shrink to a config), NEW
`services/skills/domain-run.ts` (or fold into `run.ts`), `analysis/invoice.ts` +
`analysis/bank-statement.ts` (shared plumbing → NEW `analysis/common.ts`: `singleInScopeDocument`,
`computeCoverage`, citation builder, `fmt`, ONE authoritative `loadInvoice` exported from the run
seam), tests: the existing 144+ invoice/bank/skills tests are the safety net — they must pass
unchanged (behavior-preserving refactor).

**Decisions (made):** one domain config `{domain, extractToolName, extractorVersion, latestIdFn,
persistFn, deleteFn, loadFn, errorNouns}` driving generic `runExtraction` / `prepareDownstreamRun`
/ `persistFailure` / file-export tail (extend the existing `runInvoiceFileExport` generic seam —
the audit notes it already proves the shape). Zero behavior change: this phase is green-to-green;
any behavioral fix discovered mid-refactor is reported, not silently included. R3's staleness logic
must end up in the ONE shared prepare path.

**Session prompt:**
```
Execute Phase A1 of docs/skills-remediation-plan.md (branch fix/skills-a1).
Read plan §0 + §A1, then audit §6.1 and the plumbing bullet of §6.4. Scope: a strictly
behavior-preserving refactor folding invoice-run.ts's layer-for-layer copy of run.ts into one
domain-parameterized run seam (config object per domain), and lifting the duplicated analysis
plumbing (loadInvoice, singleInScopeDocument, computeCoverage, citation builder) into shared
modules. The existing test suite is the safety net: green before, green after, no assertion
changes. If you find a real behavior divergence between the copies, STOP and report it — do not
fix it silently inside the refactor. Finish with the §0 ritual.
```

## A2 — Self-describing tool registry + per-document run controller
**Audit:** §6.2, §6.4-low (vestigial trust plumbing).
**Files:** `services/skills/tool-registry.ts`, `tool-runs.ts` (derive `WIRED_TOOL_NAMES` + runner
dispatch), `run-controller.ts` (+ shared/types `SkillRunState`), `ipc/registerSkillsIpc.ts`,
`renderer/chat/SkillRunBar.tsx` (derive label/done maps), i18n keys, tests:
`skills-tool-registry.test.ts`, `skills-run-controller.test.ts`, `SkillRunBar.test.tsx`,
`skills-tool-run-ipc.test.ts`.

**Decisions (made):** `SkillTool` registry entries become self-describing
(`labelKey, doneKey, resultShape, seamKind: extract|downstream|export, confirm, dialog{titleKey,
filterName, extensions}, countField`) — `WIRED_TOOL_NAMES`, the runner switch, renderer maps and
U5's dialog params derive from them; `ToolRunOutcome.transactionCount` → additive generic `count`
(keep the old field as a deprecated alias for one release; renderer reads `count ?? transactionCount`);
run controller scoped **per-document** (doc-lock already serializes true conflicts) — "a skill is
already working" only for the same document; `resolveEffectiveTools(declared, declared)` signature
simplified to `resolveWiredTools(declared)` (grant leg deleted until a real grant UI exists —
document in security-model.md).

**Session prompt:**
```
Execute Phase A2 of docs/skills-remediation-plan.md (branch fix/skills-a2).
Read plan §0 + §A2, then audit §6.2 and the trust-plumbing bullet of §6.4. Scope: make the
SkillTool registry entries self-describing and derive the wired-list, runner dispatch, renderer
label/done maps and save-dialog metadata from them; introduce the generic `count` outcome field
(additive, deprecated alias kept); scope the run controller per-document; simplify
resolveEffectiveTools to resolveWiredTools (documenting the removal in security-model.md). The
trust model is unchanged: tools remain app-registered only — a skill can still never register or
self-grant a tool. Behavior-preserving except the per-document concurrency and dialog metadata.
Finish with the §0 ritual.
```

## A3 — Manifest analysis mode + whole-doc gate inversion
**Audit:** §6.3, §8.2. **Depends on W1 (honest coverage), W2 (fallthrough routing), W5 (vocabulary
for the opt-out + needle/deliverable shapes).**
**Files:** `shared/skill-manifest.ts` (+ parser tests), `services/skills/analysis/*`,
`ipc/registerRagIpc.ts`, `services/skills/vocabulary.ts` (needle/deliverable shape lists),
`docs/security-model.md` (note: analysis mode is an engine choice, not a capability), tests:
`skill-manifest.test.ts`, `rag-skill-analysis.test.ts`, `skills-analysis-whole-doc.test.ts`.

**Decisions (made):** additive manifest field `analysis: 'whole-doc' | 'compare' | 'none'`
(default 'none'), honored for **instruction skills of any source** (tools stay app-registered —
SEC-1 unchanged); **invert the gate** for a skill with an analysis mode: when the skill is the
turn skill over a single (or two, for compare) fully-chunked doc(s), PREFER the whole-doc engine;
keywords now only (a) opt OUT for clearly off-topic chatter (small-talk shape list) and
(b) classify needle-vs-deliverable — needle-shaped asks go top-k when the whole-doc read would
truncate and no tree exists (W1's truncation calculus is the input). The five bundled instruction
skills declare their mode in SKILL.md; the hardcoded whole-doc-skills.ts keyword gates shrink to
the opt-out/shape roles. End-to-end tests: user-imported instruction skill with `analysis:
whole-doc` gets the engine; off-topic question with skill active keeps top-k; needle ask on an
over-budget doc keeps top-k with the W1 notice.

**Session prompt:**
```
Execute Phase A3 of docs/skills-remediation-plan.md (branch fix/skills-a3).
Prerequisites: W1, W2 and W5 merged — verify before starting. Read plan §0 + §A3, then audit §6.3
and §8.2. Scope: an additive manifest field `analysis: whole-doc|compare|none` honored for
instruction skills of ANY source (tool registration stays app-only — the security model is
unchanged and must be re-stated in security-model.md), and the gate inversion: with an
analysis-mode skill active over a matching fully-chunked scope, the whole-doc engine is the
DEFAULT; keywords only opt out (off-topic) and classify needle-vs-deliverable (needle → top-k when
whole-doc would truncate). This retires phrasing-shaped routing as the deciding gate. Follow the
plan's decisions exactly. Finish with the §0 ritual.
```

---

# Track T — evaluation infrastructure

## T1 — Eval & fixture infrastructure + real-model smoke
**Audit:** §7 (recs 1, 2, 5 — recs 3, 4 land in W5/W1).
**Files:** NEW `tests/fixtures/real-layouts/` (constructed realistic statements/invoices — NBSP,
U+2212, Summe-labels, SEPA boilerplate, dd.mm.yy, cross-year, wrapped descriptions; NEVER real
user documents), NEW `tests/integration/extractor-realworld.test.ts`, NEW fixture-hash test (parser
output snapshot per fixture → fails when extraction output changes without a version bump), NEW
opt-in real-model smoke `tests/e2e-model/skills-smoke.test.ts` (env-gated like the
model-benchmarks harness: skips without a local GGUF; one bank + one invoice + one minutes turn
asserting shape/figures-present, not prose), docs: `docs/benchmark.md` or `model-benchmarks.md`
cross-ref.

**Decisions (made):** the real-layout corpus is the single home for incident-class fixtures — every
R-phase's probe inputs get consolidated/deduplicated here; the fixture-hash test hashes
`extractTransactionRows`/`extractInvoice` outputs over the corpus and compares against a committed
snapshot keyed by extractor version (changing output without bumping the version fails with a
clear message); the smoke test is opt-in (`SKILLS_SMOKE_MODEL=<path>`), never in CI-default
`npm test`, and asserts structure (totals present, count matches fixture truth, verdict strings)
not wording.

**Session prompt:**
```
Execute Phase T1 of docs/skills-remediation-plan.md (branch fix/skills-t1).
Read plan §0 + §T1, then audit §7 (recommendations 1, 2 and 5). Scope: a committed realistic-layout
fixture corpus consolidating the incident classes (NBSP, U+2212, Summe labels, SEPA rows,
dd.mm.yy, cross-year, wrapped descriptions — constructed layouts, never real user data), an
extractor output-snapshot test that fails when parser output changes without an extractor version
bump, and an env-gated opt-in real-model smoke (one bank, one invoice, one minutes turn; asserts
structure and figures, not prose; skips cleanly when no model path is set). Nothing lands in the
default npm test that needs a model or network. Follow the plan's decisions exactly. Finish with
the §0 ritual.
```

---

## Closing the plan
When §0.2 is all `[x]`: run a final full verification session — full `npm test`, `npm run
typecheck`, a manual smoke of the three complaint flows (bank statement, invoice, meeting minutes,
each in German at 4096 ctx from D:\), then fold this plan + the audit into §-numbered design
records per the CLAUDE.md doc lifecycle rule (template: architecture.md §23), update
`known-limitations.md`, and delete both working papers.
