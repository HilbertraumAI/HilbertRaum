# PDF geometry-extraction — final pre-merge audit (Phase 31, 2026-06-24)

_Branch `pdf-geometry-extraction` (~15 commits ahead of `master`, unmerged, unpushed). Multi-persona
ANALYSIS audit before merge → master. No code was changed by this audit. Scope bounded by
`git diff master...HEAD` (26 files, +2379/−47; no production code changed in the final session — gated
harness + corpus docs only)._

## How this was verified (not taken on faith)

- **Full suite:** `cd apps/desktop && npx vitest run` → **2190 passed / 37 skipped** (matches BUILD_STATE).
- **Typecheck:** `npx tsc --noEmit` → **clean (exit 0)**.
- **Gold set (real local corpus):** `HILBERTRAUM_PDF_GOLDSET=1 npx vitest run …pdf-goldset…` → fresh run
  reproduces the documented numbers **exactly**: micro recall **116.5% (99/85)**, macro **100%**, full
  recall **3/3**, gate pass **33.3% (1/3)**, figure-exact **100% (1/1)**, hallucinated / partial-total /
  model-calls / scan-leak **all 0**, **1** image-only scan excluded. Safety invariants hold.
- **Privacy:** `git ls-files` under `tests/real-data/` returns only `README.md` + the harness;
  `git check-ignore` confirms `…/corpus/` is ignored; `git status` is clean. **No user data is tracked.**
- **D58 / non-breaking:** confirmed `layout:true` is set in exactly two places (the bank handler
  `analysis/bank-statement.ts:328` and the `extract_transactions` case `tool-runs.ts:170`); every other
  reader omits it. **`money.ts` is absent from the diff entirely** — `parseDate`/`parseAmount`/`MONEY_RE`
  are byte-unchanged (§3.2 verified at the file level, not just by inspection).

**The prompt's stated state is accurate against the code.** The two "currently-safe boundaries", the
column model + balance-label guard, the gated harness with `imageOnly` exclusion, and "zero model calls"
all match what is built. One nuance the prompt under-states: the over-extraction boundary is safe even on
a statement that *does* print opening/closing balances — see the data-integrity note under HIGH/(none).

---

## Severity-ranked findings

### CRITICAL — none

No path can present an invented, partial, or mis-totalled sum. The cardinal property holds.

### HIGH — none

I specifically tried to break the cardinal property and could not. The most important stress test
(data-integrity persona) is the prompt's boundary (1) **interacting with a statement that prints
opening/closing balances** — the one case the prompt calls "currently-safe" without proof:

> **Verified safe.** A phantom running-balance row `<date> <CUR> <balance>` parses (`bank-statement.ts:82`
> `parseLine`) with `description = <CUR>` and `amount = <balance figure>` (a large positive number), and —
> having only one money token — **no `balanceAfter`** (so it is `unknown`, never a `mismatch`, in
> `reconcileBalances`). On a statement that also prints labelled opening/closing, `isStatementComplete`
> (`bank-statement.ts:197`) checks `opening + Σamounts == closing`; the phantom injects a large balance
> value into `Σamounts`, so the tie **cannot** hold (it would require the phantoms to sum to 0, impossible
> for running balances). Result: gate downgrades → no total. The over-extraction therefore degrades a
> would-be gate-PASS into an honest downgrade, never a wrong total. **Safe, and now demonstrated, not
> asserted.** (data-integrity persona)

### MEDIUM

**M1 — §21 contradicts itself on the corpus size (docs/accuracy).**
`docs/architecture.md:2627` ("today's gold set is just **two** statements") directly contradicts the same
record's `docs/architecture.md:2594` ("Three text-layer statements … plus one image-only scan"). The
"Conditional future" paragraph was not refreshed when the breadth corpus landed. Because the plan file was
deleted and §21 is now the canonical source of truth, this internal contradiction will mislead the next
reader. **Recommend:** change "just two statements" to "still narrow (three text statements + one scan)".
_Persona: docs/accuracy auditor._

**M2 — known-limitations.md quotes the stale 2-statement "71/71" recall (docs/accuracy).**
`docs/known-limitations.md:319–323` still describes the corpus as "a sanitized HVB transactions-only
excerpt and a full Raiffeisen 'Mein ELBA' statement" reaching "**100% transaction recall (71/71)**" — the
pre-breadth (2026-06-23) numbers — even though the *same bullet* then describes the two boundaries the
**broader** (3-text + 1-scan) corpus surfaced. So the bullet is internally inconsistent and quotes a
recall figure a fresh harness run no longer produces (now 116.5%, 99/85). **Recommend:** update the
sentence to the current corpus + numbers (or, better, stop quoting a hard recall figure in
known-limitations and point at §21, which is where the live number belongs). The prompt explicitly asked
for "gold-set numbers quoted in docs vs a fresh harness run" — this is the one place they diverge.
_Persona: docs/accuracy auditor._

**M3 — CI has zero real-PDF coverage; the synthetic fixtures encode *ideal* geometry (test-correctness).**
`makeColumnarPdf` (`tests/helpers/fixtures.ts:48`) emits each cell as its own `BT … Td x y … Tj … ET`, so
pdf.js returns each logical cell as a separate `TextItem` whose `transform[4/5]` is exactly the column x
and a baseline y **identical** across the row, with column gaps of 45–60 pt. Real pdf.js output is
messier: a date can be glued to the following text in one item, a number can split across items, baselines
jitter, and adjacent columns can sit closer than `DEFAULT_COLUMN_GAP` (12 pt, `pdf-layout.ts:188`). The
unit/integration suites therefore **cannot fail on a geometry regression that only manifests on real
TextItem layout** — they assert against the idealized shape. The only real-PDF check is the gold-set
harness, which is **local-only + gated** (`describe.runIf(RUN)`, `pdf-goldset.realdata.test.ts:242`), so it
never runs in `npm test`. This is the honest central limitation: **a fixture can be green while a real
statement fails.** The gold set is the mitigation, but it lives off-CI and runs only when you remember to.
**Recommend (no action required to merge):** keep the gold set as the real gate, and treat "broaden +
re-run the harness" (already the D52 plan) as the substitute for CI realism; optionally add one tiny
committed real-pdf-derived *synthetic* fixture with deliberately jittered baselines / a tight column gap to
exercise the tolerance + gap constants. _Persona: QA/test-correctness skeptic._

**M4 — the harness measures recall but not precision; two of three recall lines hide over-extraction
(test-correctness / honest-reporting).**
`perfectRecall` uses `extractedRows >= trueRows` (`pdf-goldset.realdata.test.ts:279`), so an
over-extracted statement (28/14) is reported as "**statements at full recall … 3/3**"; `macroRecall` caps
each statement at 100% via `Math.min` (line 278), so it reads "**100%**" too. Only the micro line surfaces
the over-extraction (>100%). There is **no precision / over-extraction metric at all**, so a future
regression that adds phantom rows is invisible in 2 of the 3 recall lines and is caught only by the
slightly cryptic micro >100% signal (and, indirectly, by gate-pass-rate dropping). The labels are
defensible ("recall" legitimately ignores spurious rows) but the report as a whole over-states quality.
**Recommend:** add an explicit precision / "over-extracted statements: N" line, or rename "full recall" to
"recall ≥ 100%". This also answers the prompt's "is the >100% metric something to reframe before merge"
— it is honest but presented confusingly; fix the label, don't suppress the number. _Persona:
QA/test-correctness skeptic._

**M5 — the "hallucinated-figure MUST be 0" invariant is only armed when expected balances are supplied
(test-correctness).**
`hallucinated` (`pdf-goldset.realdata.test.ts:302–307`) early-returns `false` unless
`expectedOpening != null && expectedClosing != null`. So for any statement whose `expected.json` omits
opening/closing, the check is **vacuously 0** — yet the harness prints "`hallucinated-figure count … 0
(MUST be 0)`" as if it were an unconditional guarantee. For the current corpus the one statement that
presents a total *does* carry expected balances (figure-exact 1/1), so it is covered today; the gap is
that the guarantee silently weakens as statements without ground-truth balances are added. (`partialTotals`
at line 298 is correctly unconditional and catches under-extraction-with-a-total regardless.) **Recommend:**
either require opening/closing in `expected.json` for any statement expected to present a total, or print
the hallucination invariant as "checked over K/N statements with ground-truth balances". _Persona:
QA/test-correctness skeptic + data-integrity._

### LOW

**L1 — the downgrade copy asserts a balance *mismatch* even when no balance was printed (honesty/copy).**
`skills.bankAnalysis.incompleteNoTotal` (`i18n/en.ts`) reads "its opening and closing balances don't line
up with what I read." But the same downgrade fires for the **common** transactions-only case where the
statement printed **no** opening/closing balance at all (the HVB "Umsätze" excerpt; the English
running-balance-only fixture, `pdf-bank-layout.test.ts:426`). In that case nothing failed to "line up" —
there was nothing to tie against. Always safe (it still refuses the total), but the wording mis-states the
*reason*. **Recommend:** soften to cover both causes, e.g. "I couldn't confirm I captured the whole
statement (no opening/closing balance that ties out) …". _Persona: data-integrity / honesty._

**L2 — over-extraction inflates the user-visible row count and citations; the gate protects only the
total (honesty).**
On the over-extraction boundary the answer still leads with `skills.bankAnalysis.count` (28 instead of 14)
and `buildBankCitations` can surface the phantom rows' source pages. The cardinal property is about the
*total* (protected), but a user asking "how many transactions?" gets a wrong count, and a phantom row whose
description is a bare currency code can appear. Documented in §21 as "inflates the row count", so it is
disclosed — flagging that the disclosure covers the count *and* the row list the user sees, not just the
total. No fix required before merge (it is the deferred money-column model's job). _Persona:
data-integrity / honesty._

**L3 — the column-gap and row-tolerance constants are never exercised at their boundaries (coverage).**
`DEFAULT_COLUMN_GAP` (12 pt) and `DEFAULT_ROW_TOLERANCE` (3 pt) are load-bearing for `detectDatumColumn` /
`clusterRows`, but every fixture uses comfortable gaps (≥45 pt) and pixel-perfect baselines, so a
statement whose Datum/Valuta columns sit <12 pt apart (they would merge into one band) or whose same-row
cells jitter >3 pt (they would split into two rows) is untested. Low likelihood on real bank layouts, but
the constants are unprotected against a tuning regression. _Persona: QA/test-correctness skeptic._

**L4 — minor: "statements at full recall 3/3" alongside "micro 116.5%" is internally confusing.** Same
root as M4; listed separately only as the user-facing harness-output wording. _Persona:
architecture/maintainability._

---

## Things checked and found GOOD (no action)

- **Cardinal safety property** holds on every gold-set statement and under the stress cases above; the gate
  is the single chokepoint and `buildBankAnswer` (`analysis/bank-statement.ts:226`) downgrades on
  `!complete`, on mixed currency, and on empty rows — all three present **no** total. _(data-integrity)_
- **D58 bank-only / non-breaking:** `layout:true` is set only by the bank handler + the
  `extract_transactions` runner case; redaction/invoice/preview/translate/compare/ingest leave it unset and
  get byte-unchanged reading-order text. `money.ts` (shared `parseDate`) is **not in the diff**.
  _(architecture/maintainability)_
- **Privacy / D57:** corpus is gitignored (`.gitignore:25–28`), untracked, and the working tree is clean.
  The harness emits **only aggregates** — never a row, figure, description, or filename (the `notes`
  field is never printed); the printed `corpus dir:` line is a local path in local-only test output, not
  committed. Both new `expected.json` live under the ignored `corpus/`. _(security/privacy)_
- **Content-class isolation:** `opening_balance`/`closing_balance` are stored on `bank_statements`
  (`db.ts`, additive nullable REAL) and reach the answer only; the `skill_runs` lifecycle + audit sink stay
  ids/counts-only (`run.ts`). _(security/privacy)_
- **ReDoS / DoS:** `MONEY_RE` bounds are unchanged and proven linear (200k-char regression,
  `skills-bank-statement-tool.test.ts:116`); `DATE_TOKEN_RE`/`MONEY_TOKEN_RE`/`YEAR_TOKEN_RE` are anchored
  and linear; `clusterRows`/`detectDatumColumn` are O(n log n); the **page cap** is threaded into the real
  IPC path (`registerRagIpc.ts`, `resolveIngestionLimits().pdfMaxPages`) and honored only in layout mode.
  _(security/privacy)_
- **Scan detection** is re-keyed on RAW text (`pdf.ts:113,142`), independent of layout reconstruction, so a
  text page that yields no transaction rows is never mistaken for an image-only scan; the image-only path
  degrades to the safe empty/downgrade. _(security/privacy + data-integrity)_
- **`reconcileBalances` baseline-as-unknown** is correct and well-tested (single-transaction "verifies
  nothing ⇒ not reconciled", all-baseline, genuine-mismatch — `skills-bank-statement-tool.test.ts:237–286`).
  _(data-integrity)_
- **Docs structure:** the §-anchor legend (`architecture.md:2682–2685`) maps every deleted-plan citation
  (`§3.1/§3.1.3/§3.2/§3.5/D50–D58`) to §21; no **live link** to the deleted plan file remains (the only
  occurrences are the legend rows, which are the intended resolvable-citation mechanism per the
  doc-lifecycle rule). The §8 pointer + known-limitations repoint to §21. _(docs/accuracy)_
- **Per-phase ritual:** tests green, typecheck clean, BUILD_STATE + §21 + known-limitations updated, 15
  conventional phase-tagged commits, no scratch/temp files. _(architecture/maintainability)_

---

## Remediation applied (2026-06-24, post-audit)

The cheap findings were fixed in this session and re-verified (full suite **2190/37**, typecheck clean,
gold-set harness green with all safety invariants still **0**):

- **M1** — `architecture.md` §21 "just two statements" → "still narrow (three text statements + one
  image-only scan)".
- **M2** — `known-limitations.md` stale "71/71" two-statement recall replaced with the current corpus
  description; the live recall/gate numbers now point at §21 instead of being duplicated.
- **M4** — the harness prints a new **`over-extracted statements`** precision line and labels "full
  recall" as "recall ≥ 100%; over-extraction counts here"; README documents the precision signal.
- **M5** — the hallucination invariant now prints "**armed over K/N presented totals w/ ground-truth
  balances**" so the "MUST be 0" guarantee can't silently weaken.
- **L1** — the `incompleteNoTotal` downgrade copy (EN + DE) no longer claims a balance *mismatch* when
  no opening/closing balance was printed.

**M3 (partial hardening, 2026-06-24).** The deepest of the follow-ups was investigated rather than just
filed. Probing the token classifier on split-amount fragments revealed a genuine third boundary: a pdf.js-
**split amount** (`2.000` + `,00`) is never reassembled (no fragment is money; `1.234` even back-classifies
as a *date*), so the row is dropped — a silent recall loss, but gate-safe (empty/incomplete ⇒ downgrade,
never a wrong total). This is now **pinned by tests** (`pdf-layout.test.ts` "Stage-1 geometry edge
boundaries": split-amount drop, the `DEFAULT_ROW_TOLERANCE` first-baseline anchor, and the
`DEFAULT_COLUMN_GAP` merge; plus an end-to-end `pdf-bank-layout.test.ts` case through real pdf.js) and
**documented** as boundary (3) in §21 + known-limitations. The two load-bearing tuning constants
(row-tolerance 3 pt, column-gap 12 pt) are now regression-locked. What remains open (and is the
irreducible core of M3) is that these are still synthetic word-boxes / forced splits — the **gold set
stays the only real-distribution gate**, run locally. The scoped code fix (an x-adjacency money re-merge)
is deferred with the money-column model.

Still open as tracked follow-ups (not merge blockers): **M3 residual** (real-PDF CI realism — the gold
set remains the agreed substitute) and the deferred money re-merge / money-column model; **L2/L4**
(documented boundaries). **L3** (the tuning-constant edge coverage) is now closed by the new tests.

## GO / NO-GO for merge

**GO.** (Originally conditional on M1 + M2; both are now fixed above.)

There is **no correctness or safety blocker.** Tests (2190/37) and typecheck are green, the gold set
reproduces every documented number, the cardinal data-integrity property is verified (including the
under-stated over-extraction × labelled-balance interaction), D57 privacy holds, and D58 / `parseDate`
non-breaking guarantees are confirmed at the file level.

**Must-fix before merge (cheap, doc-only):**
- **M1** — remove the "just two statements" contradiction in `architecture.md:2627`.
- **M2** — refresh / de-quote the stale "71/71" two-statement recall in `known-limitations.md:319–323`.

These are must-fix only because §21 + known-limitations become the canonical source of truth the moment the
plan file is gone (it already is), and shipping a design record that contradicts itself and its own harness
output is exactly the drift the doc-lifecycle rule exists to prevent. Both are one-line edits.

**Track as follow-ups (do not block merge):**
- **M3** real-PDF CI realism (the gold set is the agreed substitute — keep broadening + re-running it).
- **M4 / L4** add a precision/over-extraction line to the harness and relabel "full recall" (this also
  resolves the "should we reframe the >100% metric" question: reframe the *label*, keep the number).
- **M5** arm the hallucination invariant only over statements with ground-truth balances (or require them).
- **L1** soften the downgrade copy to cover the "no balance printed" reason.

None of the deferred decisions (the money-column model, Stage 2) are touched or relitigated here; the
deferral is appropriately recorded and is acceptable to merge.
