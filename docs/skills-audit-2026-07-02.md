# Skills & Tools Audit — 2026-07-02 (triggering, coverage, determinism-vs-LLM, architecture)

> **Status: OPEN — remediation planned.** Execution plan with per-session phases + prompts:
> [`skills-remediation-plan.md`](skills-remediation-plan.md) (tracker in its §0.2).
> This is the full audit report requested by the owner
> after repeated user complaints about app-skill result quality. Per the doc lifecycle rule
> (CLAUDE.md), once remediation lands this file should be condensed into §-numbered design records
> in the topic docs (the 2026-06-26 audit → `architecture.md` §23 is the template) and deleted.
>
> **Method.** Multi-agent audit (111 agents, ~7.6M tokens): 6 parallel readers mapped the system;
> 7 dimension finders (coverage, triggering, determinism, architecture, extraction quality, UX,
> testing) produced 108 raw findings; deduplication left 73; every finding was then adversarially
> verified against the working tree (critical/high findings by two independent verifiers, one
> prompted to refute, one re-deriving from code). **56 findings confirmed, 5 refuted and dropped,
> 12 testing-dimension findings could not complete adversarial verification** (spend limit) — the
> four most load-bearing of those were manually re-verified afterwards (marked ✔ in §7). Several
> extractor findings were confirmed by *executing the real modules* against probe inputs, not just
> reading them. Line numbers reference the working tree as of 2026-07-02.

| Severity | Count | Dimensions |
|---|---|---|
| **Critical** | 2 | coverage, quality |
| **High** | 17 | determinism 4 · quality 6 · architecture 4 · coverage 1 · triggers 1 · ux 1 |
| **Medium** | 26 | spread across all dimensions |
| **Low** | 11 | — |
| Verified-but-incomplete (testing) | 12 | see §7 |

---

## 1. Executive summary — answers to the three questions that prompted this audit

### 1.1 "Skills analyzed just parts of a doc where it was clear we need the full document"

**Confirmed, with a chain of four independent root causes.** Any one of them alone produces the
complaint; in practice they compound:

1. **Multi-document scope silently disables every whole-document engine** ([CRITICAL], §2.1).
   Every analysis handler demands *exactly one* in-scope document (exactly two for `what-changed`).
   The default conversation scope is the whole library, so for most users the whole-doc machinery
   never fires — the turn silently degrades to top-k retrieval, where at the default 4096-token
   context the model sees **~2 excerpts (~1000 words)** of a bank statement and happily sums the
   handful of transactions it can see. No notice of any kind is emitted.
2. **The whole-doc path is itself a prefix read** ([HIGH], §2.2). Even when it fires,
   `retrieveWholeDocument` stops at the first chunk that would overflow the budget — at the shipped
   4096 context that is **~2–3 chunks (~2 pages)**. The model is *never told* its input is partial,
   while the skill body simultaneously demands an exhaustive deliverable — so minutes of a 10-page
   transcript assert "no explicit decisions found" for decisions that live on page 5. The only
   honesty signal is a small renderer badge. The tree map-reduce rescue is real but dormant for
   default users (requires a manually built deep index).
3. **Keyword-substring routing decides whole-doc vs top-k, and misses silently downgrade**
   ([HIGH], §2.3/§4.1). "Summarize this meeting" does not match the meeting handler's list
   (`'summarize meeting'` is not a substring of "summarize *this* meeting") → top-k minutes.
4. **The machinery is unreachable without a manual skill pick** ([HIGH], §2.4). Suggestion is an
   inert offer; auto-fire is *doubly* dormant (setting default-off **and** only `document-redaction`
   opts in via `triggers.autoFire`). A user who just asks "Summarize my bank statement" with no
   skill selected gets the LLM over ~2 retrieved chunks — the weakest configuration the app has.

### 1.2 "It feels like we try too much with our skills/tools and don't let the LLM enough room"

**The feeling is correct, but the diagnosis needs precision.** Determinism for *figures* is right
and should stay (the project's own Phase-33 rule: the LLM never moves a total — and the shipped
4B-Q4 model hallucinated 3/15 on the invoice benchmark, so that rule is evidence-based). What is
wrong is that the deterministic layer owns **answer generation** instead of **evidence
preparation**:

- With a tool skill active, ~41 broad substrings (`total`, `tax`, `sum`, `vendor`, `how much`,
  `summe`, `steuer`, `betrag`…) intercept *every* matching question and return a **fixed,
  question-invariant template** with zero model calls. "Who is the vendor?" is intercepted by the
  keyword `vendor` and answered by a template that **does not contain the vendor** — the field sits
  parsed in the DB one line away, loaded by the handler, and used only for currency (§3.1).
- **The extracted structured data never reaches the LLM.** The rows are tiny (typically 20–100
  transactions, capped at 10k) and would fit the context trivially as JSON — the safe middle path
  ("LLM answers the actual question over deterministically verified rows") simply does not exist.
  Every question is either template-answered or handed raw document chunks (§3.1).
- The broad keyword lists are themselves a *workaround* for that missing middle path: the code
  comments say keywords were widened because German asks that missed them "fell through to generic
  RAG, which stuffs the whole statement into the model and overflows the context window"
  ([bank-statement.ts:50-54](../apps/desktop/src/main/services/skills/analysis/bank-statement.ts#L50-L54)).
  The deterministic layer is compensating for a retrieval-layer gap by over-intercepting.
- There is also an **inverse** failure: `share-safe-review` delegates a privacy verdict entirely to
  the LLM over possibly-partial text, while the deterministic whole-document PII detectors that
  already exist (redaction tools) are never fed into it (§3.5).

**The architectural conclusion:** keywords should select the *shape* of the answer, not decide
whether the document gets read whole; and between "deterministic template" and "raw chunks" the
system needs the third mode — *grounded generation over extracted, verified structured data*. §8
lays out the concrete design.

### 1.3 Triggering — "how we trigger them"

**The trigger system has structural defects at every layer** (§4): every skill carries **two
independently hand-maintained keyword vocabularies** (manifest triggers for suggestion; hardcoded
TS lists for routing) that have already drifted — the phrase that earns the suggestion can fail to
route after acceptance; matching is raw substring with no word boundaries (`'net'` ⊂ "Netflix",
`'sum'` ⊂ "assume", `'minutes'` ⊂ "in 10 minutes") despite manifest comments promising otherwise;
suggestion scoring is biased by keyword-list length (6 vs ~31 across skills) and by an
alphabetical tie-break; every picker pick silently becomes a conversation-wide sticky default with
no per-turn apply and no undo for manual picks; and the shipping suggestion threshold measures
**60.7% precision on the project's own eval corpus** (run during this audit: 11 wrong fires on 33
turns) — a corpus that itself covers only 4 of the 8 skills.

---

## 2. Coverage — why documents get analyzed partially

### 2.1 [CRITICAL] Multi-document scope silently disables every whole-document engine
`analysis/bank-statement.ts:88-91`, `analysis/invoice.ts:74-77`, `analysis/whole-doc-skills.ts:38-46`, `registerRagIpc.ts:195-202`

All eight handlers gate on an exact in-scope document count (1, or 2 for compare). When the count
is off — the default whole-library scope, or a statement plus any second document — `applies()` is
false and the turn falls through **byte-unchanged and silently** to top-k retrieval (~2 excerpts at
default context). The suggestion machinery compounds it: suggestions are scored over the
*unnarrowed* scope with `requireChunks:false` ([scope-signals.ts:12-29](../apps/desktop/src/main/services/skills/scope-signals.ts#L12-L29)),
so the app actively offers the bank skill in exactly the configuration where accepting it yields
the degraded path (offer/execution mismatch). Nothing in the UI or answer distinguishes
"exhaustive whole-document read" from "2 passages" except the small coverage badge.
**Fix:** when a turn skill *has* a handler and `applies()` fails only on document count, do not
fall through silently — narrow to the best-matching document (the filename auto-scope and the
run-bar's document chooser both exist as precedents) and say so, or emit a deterministic routing
answer ("pick one statement to analyse fully — right now I can only see excerpts").

### 2.2 [HIGH] The "whole document" read is a silent prefix read at default context
`rag/index.ts:391-430, 918-934`; `CoverageMeter.tsx:42-45`

`wholeDocumentBudgetTokens` = 4096 − 1024 response reserve − system prompt − question − fence ≈
**~1900–2400 tokens ≈ 2–3 chunks**. `retrieveWholeDocument` reads chunks from index 0 and "stops as
soon as the next chunk would overflow" — the tail is dropped. The prompt carries **no partial-input
notice**, while skill bodies demand exhaustive sectioned deliverables, so the *answer text itself*
claims completeness ("no decisions found"). Related confirmed defects in the same path:

- **[HIGH] German subword overflow** (`rag/index.ts:918-934` vs `:943,961`): the whole-doc budget
  uses the 1.3 tokens/word estimate with **no** safety factor, while the relevance path applies
  `RETRIEVAL_FIT_SAFETY = 1.5` for exactly this reason ("a German account statement can run closer
  to ~2 real BPE tokens/word — the fix for the HTTP 400 'exceeds context size'"). Budget-filling
  German whole-doc turns — the flagship de-AT flows — can exceed n_ctx and **fail with a raw
  runtime error**.
- **[MEDIUM] ~16% of the scarce budget is duplicated text** (`rag/index.ts:396-401`): the path
  reads the overlapping retrieval chunks (80-token overlap per 500-token chunk) instead of the
  non-overlapping segment reader the §19 extractor path already uses. At 2–3 chunks, the overlap
  costs roughly one whole extra chunk of real coverage.
- **[MEDIUM] The tree rescue lies at the margin** (`whole-doc-tree.ts:177, 121-128`): when the
  joined map notes exceed the reduce budget they are hard-truncated **while coverage stamps
  `truncated:false`** and the prompt still asserts whole-document coverage; the map loop also has
  no call ceiling (the summary path caps at 12).
- **[MEDIUM] Compare fallback** (`rag/index.ts:490-525`): pairs the diff refuses (rewrites, >20k
  words/side, dissimilar docs) fall back to ~1-2 chunks *per document* with no in-prompt notice —
  the exact COMPARE-DIFF-1 failure mode, surviving for the pair classes the fix excluded
  (documented as deferred, judged here still user-impacting).
- **[MEDIUM] Needle questions routed into whole-doc get strictly worse answers**
  (`whole-doc-skills.ts:95-104`): 'Wie lange ist die Kündigungsfrist?' hits `'kündigung'`+`'vertrag'`
  → grounded-whole-doc → prefix read that likely *excludes* the termination clause on page 7,
  while plain top-k would have retrieved it. Selecting the contract skill can make specific
  questions worse than no skill. Routing must distinguish deliverable-shaped from lookup-shaped asks.

**Fixes (coordinated):** inject an explicit truncation notice into the grounded prompt ("you see
sections 1–N of M — say your output covers only the beginning"); apply the 1.5 divisor to the
whole-doc and compare budgets; de-overlap chunks when concatenating; propagate the tree-notes
truncation into the coverage stamp and add a map ceiling; auto-build (or one-click offer) the deep
index when a whole-doc turn hits `truncated:true`; route lookup-shaped questions to top-k when the
whole-doc read would truncate.

### 2.3 [HIGH] Silent row drops asserted as exhaustive reads
`en.ts:592` ("I read the whole invoice — **{count}** line items."), `analysis/invoice.ts:242`, `money.ts:31-34`

The drop-don't-guess parser posture is right, but dropping **silently while claiming
exhaustiveness** is not: round-integer line items, wrapped descriptions, currency-less rows all
drop without a trace, and the INVOICE-TOTALS-1 fix (currency-adjacent bare integers) applies only
to *labeled totals lines* — not to line items, not to bank balance lines
(`lastMoneyOnLine`, `bank-statement.ts:249-253` still uses `MONEY_RE` only, so an "Opening balance
914 $" statement loses its completeness gate). **Fix:** count parser-rejected money-bearing lines
during extraction, persist a `droppedRowCount`, and gate the "whole invoice/statement" phrasing on
it; extend the currency-adjacent integer read to bank balance lines.

### 2.4 [HIGH] The whole-doc machinery is unreachable by default
`autofire.ts:41,54`; `shared/types.ts:275-276`; `app-skills/document-redaction/SKILL.md:22`

Auto-fire requires the user setting (default **false**, "ships inert") *and* per-skill
`triggers.autoFire` — which only `document-redaction` sets. Bank-statement, invoice and
meeting-protocol — the skills in the owner's complaint — **can never auto-fire even after the user
enables the setting**. Without a turn skill, no handler is consulted and the turn takes top-k.
**Fix:** opt the three complaint skills into `autoFire` (their `applies()` gates are already
single-doc + intent-shaped and the S13c undo exists); longer-term, route analysis-shaped single-doc
questions to a whole-doc read even skill-free (the coverage-extract router at
`registerRagIpc.ts:339-366` proves skill-less deterministic routing is an accepted pattern).
Note the precondition: fix suggestion/auto-fire signal quality first (§4.4) — auto-firing with
whole-corpus doc signals would misfire.

---

## 3. Determinism vs LLM — the division of labor

### 3.1 [HIGH] Fixed templates intercept every keyword-matched question; extracted data never reaches the LLM
`analysis/invoice.ts:42-54, 232-302, 312-385`; `analysis/bank-statement.ts:55-63, 319-439`
*(Documented as a STILL-OPEN product call in BUILD_STATE; this audit judges the residual no longer acceptable.)*

`run()` inspects the question exactly once — `detectFormat()` for json/csv/xml. Everything else
gets `buildInvoiceAnswer` / `buildBankAnswer`, pure functions of the extracted rows that take **no
question parameter**: count → mismatches → totals → ≤20/10 rows → caveat. Consequences, all
confirmed: "Who is the vendor?", "Wann ist die Rechnung fällig?", "What is the vendor's tax ID?",
"Übersetze die Rechnung" → the identical totals template (vendor, dates, invoice number are loaded
at `invoice.ts:102-107` and used only for currency in prose). "How much did I spend on groceries in
March?" → the global in/out/net template with no date/merchant/max logic. Follow-ups
("Warum stimmen die Summen nicht?" — contains `'summe'`) re-trigger the **byte-identical** template
([MEDIUM], stateless handler, history never consulted) — the skill feels robotic precisely in the
conversations where users engage most. **This is the single highest-leverage fix in the audit**
(§8.1): keep extraction + reconciliation deterministic and authoritative, but for questions that
aren't plain "summarize/reconcile/list" asks, build a grounded prompt containing the serialized
persisted rows + header + validation results (the object `buildInvoiceJson` already produces) and
let the LLM answer the actual question over verified data, quoting figures verbatim.

### 3.2 [HIGH] Substring gates fail in both directions
`bank-statement.ts:55-63,77`; `invoice.ts:40-49`

Over-fire: `'net'` ⊂ "Netflix"/"internet" — "Wie kündige ich mein Netflix-Abo?" is intercepted by
the 0-model bank template; `'tax'` ⊂ "syntax", `'bill'` ⊂ "billboard", `'sum'` ⊂ "assume" — the
invoice list directly contradicts its own comment ("Bare, substring-ambiguous tokens are avoided").
Under-fire: any German paraphrase off the list silently downgrades to partial top-k — the
documented incident class ("Kategorisiere die Transaktionen", "gesamtwert"). A word-boundary
matcher (`wordIncludes`, `tools/money.ts`) already exists in the codebase — the routing gates just
don't use it. Four separate shipped incidents trace to this one mechanism.

### 3.3 [MEDIUM] The bank handler's own template points at an escape hatch that doesn't exist
`en.ts:584-585`; `bank-statement.ts:38-39`

"…and **{count}** more — ask me to export the statement as CSV to see every row." — but the bank
handler has no format mode (invoice got JSON/CSV/XML inline; bank didn't) and can never export.
Asking exactly what the answer suggests re-triggers the same template, an infinite loop. Port
`detectFormat` + inline serialization to the bank handler; point the copy at the run-bar Export
button.

### 3.4 [MEDIUM] Routing-mode deflections and scope policing delegated to the model
`analysis/redaction.ts:35-71`; `app-skills/what-changed/SKILL.md:41-43`

"Welche personenbezogenen Daten enthält das Dokument?" — an informational ask the deterministic
detectors could actually answer — gets the fixed "click the Redact button" copy; there is no
dry-run/preview path at all. And `what-changed` instructs the *model* to refuse when scope ≠ 2
documents — information only the app has (the model sees excerpts, not the scope); a deterministic
routing answer ("select exactly two documents") is the established pattern one file away.

### 3.5 [MEDIUM] share-safe-review: the inverse failure — LLM owns what determinism should
`app-skills/share-safe-review/SKILL.md:42-44`; `tools/redaction.ts`

A privacy-gating verdict ("Likely low risk after review") can be issued from 2 retrieved chunks or
a truncated prefix, while the deterministic whole-document PII detectors (email/URL/IBAN/phone)
exist and are wired only to the write-a-copy flow. Feed a deterministic whole-doc scan summary into
the share-safe prompt ("scan found N emails, M IBANs…") and gate the low-risk verdict string on
non-truncated coverage.

### 3.6 Smaller confirmed items
- **[MEDIUM] Fence trimming drops honesty rules first** (`prompt.ts:140-147`): over budget, the
  fence keeps leading paragraphs — and every shipped skill body puts its safety/honesty rules
  *last*; the `trimmed`/`omitted` flags are discarded at both call sites, so decapitated-rule turns
  are undiagnosable. Reorder bodies (rules first) and log/badge trimmed fences.
- **[LOW] Inline invoice CSV silently omits header+totals** while JSON/XML carry them, under an
  intro claiming "the invoice as CSV" (`invoice.ts:215-224`).
- **[LOW] One-blob answers**: exhaustive-path answers arrive after a potentially long silent
  extraction with no progress signal (`registerRagIpc.ts:303-318`) — easily read as a hang.

---

## 4. Triggering & routing

### 4.1 [HIGH] Two drifted keyword vocabularies per skill
`app-skills/*/SKILL.md` triggers vs `analysis/*.ts` keyword arrays

Suggestion and routing are independent substring lists nobody keeps in step. Confirmed
composition failure: meeting-protocol's manifest has bare `'meeting'`,`'notizen'` (suggestion
fires); the routing handler needs `'meeting minutes'`/`'summarize meeting'`/`'protokoll'` — so
**"Summarize this meeting" earns the offer, and after accepting, produces minutes from ~2-4
retrieved chunks** with no signal. Reverse: bank's manifest has only 6 keywords, so German
phrasings that *route* fine never get *suggested*. **Fix:** single-source the per-skill bilingual
vocabulary in code, generate both consumers from it, and add a parity test (every manifest keyword
either routes or is annotated suggest-only). Seed from the incident list.

### 4.2 [MEDIUM] Raw-substring suggestion matching + structurally biased scoring
`selector.ts:26,88-101,124`

One keyword hit (weight 2) alone clears the threshold; hits are an **uncapped count** ×2 while doc
signals cap at 1 each — so self-overlapping lists ("meeting minutes" hits `meeting minutes` +
`meeting` + `minutes` = 6) and list-length disparity (bank 6 vs meeting-protocol ~31) decide
cross-skill competition, and ties break alphabetically (bank-statement systematically shadows
invoice, whose `*bill*` glob co-fires). A library containing one `statement_2026.pdf` plus any PDF
gives a permanent question-independent score 2 → standing offers on "hello". Measured on the
project's own corpus during this audit: **threshold-2 = 60.7% precision** (vs keyword-required
81%, threshold-3 100%). **Fix:** require ≥1 keyword for any suggestion, cap the keyword
contribution, dedupe overlapping hits (longest match wins), use `wordIncludes` for single-word
keywords, normalize list sizes.

### 4.3 [MEDIUM] Sticky-default semantics: conversation-wide, silent, no per-turn apply, no undo
`ChatScreen.tsx:727-737`; `turn.ts:43-55`

Every pick — including accepting a one-off suggestion — persists as the conversation default;
every later turn is intercepted whenever it brushes a keyword, otherwise carries the fence (biasing
unrelated answers), **and blocks auto-fire** for better-matching skills. The "answer without it"
undo exists only for auto-fired rows. A large contributor to "inconsistent results": answer style
flips on a pick made many turns ago. **Fix:** per-turn apply with an explicit "keep for this
conversation" toggle, or extend the undo affordance to all skill-stamped answers + a persistent
composer chip with ×.

### 4.4 [MEDIUM] Auto-fire's corroboration is nearly vacuous at whole-corpus scope
`scope-signals.ts:12-29`; `selector.ts:36`

Doc signals are computed over the full unnarrowed scope, so "keyword + ≥1 doc signal" degrades to
"keyword + any matching PDF anywhere in the library". The redaction manifest additionally fires on
words (`'dsgvo'`, `'datenschutz'`, `'gdpr'`) its own handler doesn't recognize — an auto-fired
"Was regelt die DSGVO?" gets a redaction-flavored fence on an informational question. Dormant
today, but it weakens the case for the §2.4 expansion until fixed: compute signals over the
narrowed scope (attachments / explicit selection), align manifest↔handler vocabularies.

### 4.5 [MEDIUM] No document-plausibility gate
`invoice.ts:305-310`; `bank-statement.ts:442-447`

`applies()` checks question shape + doc count — never whether the single doc *is* a
statement/invoice. With the bank skill sticky and a contract in scope, "Give me a summary" runs the
bank extractor over the contract and answers "I read the whole statement but couldn't find any
transactions" — the actual request is never attempted; a fee table in a contract can even yield
plausible-looking phantom line items. **Fix:** consult the skill's own mime/filename triggers or
fall through to the grounded path when extraction yields zero rows on a doc that doesn't match the
skill's signals.

### 4.6 [LOW] The X-1 "one scope query" consolidation is already violated
`registerRagIpc.ts:33-45`; `analysis/redaction.ts:49-60`

Two private copies of the in-scope-documents query exist beside the shared helper whose comment
declares drift "impossible"; the IPC copy has **no ORDER BY** and picks the whole-doc target and
the compare pair — the direct cause of §5.1. Delete both copies; add a grep test.

---

## 5. Extraction & result quality (correctness)

### 5.1 [HIGH] `what-changed` compare direction is unspecified SQL row order asserted as fact
`registerRagIpc.ts:33-45,271`; `rag/index.ts:568,627-630,809-813`

`documentIds[0]` = "old", `[1]` = "new" — from a query with no ORDER BY (effectively import
order), while the prompt tells the model the changes are "complete and exact" from old to new. A
user who imported the new contract first gets **every addition reported as a removal, with full
confidence** — the worst failure mode for the skill's core promise. **Fix:** never assert a
direction the app can't know — label by title + import date, ask the user (one-tap "older: A or
B?"), or infer from filename version markers; at minimum reword to "differences between Document 1
(title) and Document 2 (title)".

### 5.2 [CRITICAL] Invoice label-prefix matching consumes ordinary line items as totals/header
`tools/invoice.ts:155-170, 209-225, 447-449` — *confirmed by executing the real module*

Labels match as bare case-insensitive line-start prefixes against every line, first-wins. A line
item beginning with a label word is misclassified: **"Steuerberatung Jänner 500,00 EUR"** (the
canonical Austrian tax-advisor invoice) → `steuer` prefix → its price becomes `taxTotal`;
"Netto-Miete Objekt 3 1.000,00" → `netTotal`; "Total hours consulting…" → gross; the item vanishes
from the list and the invoice's *genuine* totals block further down is discarded (first-wins).
Wrong figures are then presented as "exactly as printed", exported to JSON/CSV/XML, and persisted.
**Fix:** require a separator/word boundary after the label; only treat a line as a totals line when
the remainder is essentially just the figure; prefer the *last* totals block; never let header
matching consume a line that also parses as a money-bearing item. Add
Steuerberatung/Total-hours/Due-diligence regression fixtures. Bump `INVOICE_EXTRACTOR_VERSION`.

### 5.3 [HIGH] Character-encoding side doors: Unicode minus and NBSP grouping
`tools/money.ts:81-82,106` — *confirmed by executing the real module*

- **U+2212/en-dash minus loses the sign**: '−45,90' → **+45.9**. Debits parse as credits; on
  balance-less statements (no D56 gate) in/out/net are confidently wrong; the per-row listing shows
  flipped signs even when the gate fires.
- **NBSP/U+202F/U+2019-grouped amounts truncate to the last group**: '1 234,56' (NBSP) → **234.56**
  — magnitudes wrong by 1000×; on invoices there is no gate at all.

**Fix (one function):** a shared normalization pre-pass in front of all extractors — U+2212/2013/2011
→ `-`, NBSP family → space, U+2019 → `'` — plus extractor version bumps. Highest
correctness-per-line-of-code fix in the audit.

### 5.4 [HIGH] Missing German totals labels → phantom line items + empty totals
`tools/invoice.ts:165-170`; bank: `bank-statement.ts:215`

`Summe`, `Gesamtsumme`, `Rechnungssumme`, `Endsumme`, `Endbetrag` match no label → summary lines
fall through to `parseLineItem` and become phantom items while `totals` stays `{}` — reproducing
the INVOICE-TOTALS-1 complaint shape via vocabulary instead of number format. The invoice extractor
also lacks the bank's summary-line drop (`isBalanceLabelLine`). Bank side: only the exact
`'kontostand per'` is recognized; "Kontostand am/zum" (several AT/DE banks) silently loses the
completeness gate. **Fix:** extend both label lists, add an invoice summary-line guard, bump
versions.

### 5.5 [HIGH] `'sepa'` categorization rule blocks the LLM for most de-AT rows
`tools/bank-statement.ts:693`; `categorizer.ts:149-168`

The bare `sepa` description rule deterministically labels most Austrian/German rows "Transfer",
and the prefilter treats any description-rule hit as *confident* — skipping the model entirely.
Netflix, rent, and a doctor refund all land in one meaningless bucket; the 15-category LLM taxonomy
exists precisely for these rows. **Fix:** drop/demote the rule; never let a boilerplate-prefix
match veto the model when a runtime is loaded.

### 5.6 [HIGH] Run-bar tools serve and export stale-extractor rows
`run.ts:525-536`; `invoice-run.ts:373-383`

Staleness re-extraction (`isBankStatementStale`/`isInvoiceStale`) is enforced only on the
chat/doctask paths. After an update bumps the extractor version *because figures were mis-read*,
the Validate/Summarize/**Export** buttons still use the old rows — writing known-bad figures into
durable files. The version history (sign theft, wrong currency, 1000× understatement) proves stale
rows are confidently wrong. **Fix:** staleness check in `prepareStatementRun`/`prepareInvoiceRun`
(re-extract or fail `needsExtraction`); consider a fixture-hash test forcing version bumps.

### 5.7 Medium/low extraction findings (confirmed)
- **[MEDIUM] dd.mm.yy dates → zero rows** on CSV/text sources (`money.ts:264-283`); the geometry
  path already has safe century expansion (`pdf-layout.ts:169-173`) — port it.
- **[MEDIUM] Cross-year statements**: one page year stamped on all bare dates — December rows on a
  January statement dated a year forward (`pdf-layout.ts:452-460`); add month-rollover logic.
- **[MEDIUM] Redaction gaps**: card PANs (even space/dash-grouped) pass unmasked — a cheap
  Luhn-validated detector fits the posture; 0-leading reference numbers falsely masked as
  `[PHONE]` (corrupts invoices in the share flow); US-order/2-digit-year birthdates pass.
- **[MEDIUM] Line-item descriptions carry column debris** ("1 Web hosting 12 Monate 1 0%"),
  quantity/unitPrice misassigned — now a first-class defect since JSON/CSV/XML made the structure a
  deliverable (documented as cosmetic pre-FORMAT-1; no longer). Cheap wins: strip leading index,
  split trailing `<int> <pct>%`.
- **[MEDIUM] Wrapped descriptions silently dropped** on all non-geometry paths — merchant names
  vanish, degrading the categorizer and listings; append dateless/money-less follower lines.
- **[LOW]** Bare-integer totals fallback drops the sign (credit notes read positive,
  `invoice.ts:246,280`); **[LOW]** "exactly as printed" figures re-formatted to EN decimals in
  German answers (`fmt` = `toFixed(2)`); **[LOW]** all-ambiguous-date docs read day-first with no
  caveat (documented residual — judged to need at least a statement-level flag + one honest
  sentence).

---

## 6. Architecture & scaling

### 6.1 [HIGH] The second domain was added by copy, not parameterization
`invoice-run.ts` (self-described "mirrors run.ts layer-for-layer": ~500 of 576 lines structural copy)

Extraction inner, prepare, persistFailure, latest/stale helpers, and the cancel/save/export block
exist in 2–4 copies (one beside its own generic replacement, `runInvoiceFileExport`). This class
already caused user-visible divergence once (the "45 vs 22 transactions" incident: two drifted
segment readers + a missed `replaceExisting`). §5.6 above is the *same* class (staleness logic on
one path, not the other). **Fix:** one domain-parameterized run seam driven by a config object
`{extractToolName, persistFn, latestIdFn, extractorVersion, …}`; `runInvoiceFileExport` already
proves the shape.

### 6.2 [HIGH] A 9th tool skill costs ≥10 files across four layers
`tool-runs.ts:39-55, 241-396`; `tool-registry.ts:229-242`; renderer maps; two locale catalogs; db.ts; analysis/index.ts…

Every tool name is repeated in ~9 hardcoded locations (registry, wired-list, an 11-case runner
switch, renderer label/done maps, i18n×2, …). Confirmed drift-shaped consequences already shipped:
the one hardcoded **CSV save dialog serves every export** — redaction's "Save redacted copy" gets
an "Export transactions" title with a `.csv` filter (fighting `invoice.json` on Windows); the
generic outcome channel is bank-shaped (`transactionCount` carries line-item and redaction counts);
one `SkillRunController` serializes runs **app-wide** ("A skill is already working" across
unrelated conversations). **Fix:** make the `SkillTool` registry entry self-describing
(labelKey, doneKey, resultShape, seamKind, confirm, dialog metadata) and derive everything else;
rename the count field (additive alias); scope the controller per-document (the doc-lock already
serializes real conflicts).

### 6.3 [HIGH] Routing intelligence is app code; skills are portable in name only
`analysis/index.ts:56-74`; no manifest field for analysis mode

Whether a skill reads the whole document is decided by hardcoded handlers keyed on `'app:<id>'`
install ids and per-skill TS keyword arrays. Structural effects: every phrasing gap is a per-skill,
per-language TS patch (the recurring incident class); **any user-imported skill — and any 9th
bundled skill whose author forgets the handler — silently gets top-k-with-fence**, i.e. exactly the
partial-document behavior under audit. For `grounded-whole-doc` there is no security reason for
this (it's an engine choice, not a capability grant — unlike tools/SEC-1). **Fix:** a manifest
field (`analysis: whole-doc | compare | none`) honored for instruction skills of any source, and
**invert the gate**: when a skill is explicitly selected over a single fully-chunked doc, *prefer*
the whole-doc engine and use keywords only to opt *out* for off-topic chatter (§8.2).

### 6.4 Medium/low architecture findings
- **[MEDIUM]** Handler plumbing copied ×2–3 (`loadInvoice` verbatim twice — one feeding
  `preloaded` into the other's seam; `singleInScopeDocument` ×3; `computeCoverage`, citation
  builder, `fmt` ×2) — lift into `analysis/common.ts`, one authoritative loader.
- **[MEDIUM]** Trigger eval corpus covers 4 of 8 skills (`tests/eval/skill-triggers.ts:34`) —
  precisely excluding the Professional Documents skills with the most collision-prone bare-noun
  keywords (`vertrag`, `frist`, `kündigung`, `änderungen`) and their cross-skill confusion cases.
- **[LOW]** Vestigial trust plumbing: `resolveEffectiveTools(declared, declared)` — the userGrant
  leg collapsed; manifest `permissions` render identically for all 8 skills (display-only) —
  either build the grant UI or simplify the signature; show the actual differentiator (tool list).

---

## 7. Testing & evaluation

*The adversarial-verification pass for this dimension was cut short by the spend limit; findings
marked ✔ were manually re-verified afterwards (harness executed / files read). The rest are
single-sourced but consistent with the verified incident history — treat as high-confidence leads.*

- ✔ **Suggestion precision is measured and bad, and nothing gates it**: the shipping threshold-2
  policy scores **60.7% precision / 100% recall (11 wrong fires, 33 turns)** on the project's own
  corpus — the harness prints it on every run; only the (dormant) auto-fire threshold has an
  asserted bar (≥0.95). There is no precision gate for the surface users actually see.
- ✔ **The eval corpus is 33 synthetic turns labeled over 4 of 8 skills**, each with 0–1 curated
  docs — the auto-fire "100% precision" was measured under scope conditions production never has
  (whole-corpus doc signals, §4.4).
- ✔ **No skill path is ever exercised against a real model** — all skills/RAG tests run the mock
  runtime. This is the same test-blindness class that shipped RUNTIME-5/6 (vision salad) and
  INVOICE-TOTALS-1 (green tests, synthetic fixtures without round-integer totals). There is no
  gold-set answer eval for skill turns at all.
- ✔ **The S12 live run-surface capture has been deferred through four waves**
  (`docs/design-review/skills-s12/README.md`) while the run-bar/UI-flow incident class kept
  recurring.
- **Fixture realism**: committed extractor fixtures are synthetic and post-hoc (built to match the
  parser); the only real-layout corpus is local and git-ignored. Every recent incident
  (INVOICE-TOTALS-1, HVB zero-transactions, NBSP/Unicode classes in §5.3) is a real-layout feature
  synthetic fixtures didn't carry.
- **Whole-doc/compare fixtures are sized to avoid truncation** — no regression test exercises a
  realistically-sized document at the default 4096 context; no test measures real BPE token counts
  of an assembled German prompt (§2.2's overflow would have been caught).
- **No test connects suggestion → acceptance → routing** (the §4.1 drift and §2.1 offer/execution
  mismatch live in that gap); tests assert silent degradation as "graceful" — fixing the no-signal
  UX will require updating tests that currently enshrine it.
- **German coverage is thin and asymmetric** across skills tests, though German-first incidents
  dominate the incident history.

**Recommended evaluation infrastructure** (ordered): (1) a real-layout fixture corpus (sanitized
statements/invoices from the incident list — NBSP, U+2212, Summe-labels, SEPA rows, dd.mm.yy,
cross-year, wrapped descriptions) run through the *real* extractors in CI; (2) an extractor
fixture-hash test forcing version bumps; (3) expand the trigger corpus to 8 skills + confusion
pairs + German paraphrases, and put a precision bar on the *suggestion* threshold; (4) a
whole-doc-at-4096 truncation regression suite (incl. a German-token-count assertion); (5) a small
opt-in real-model smoke (the model-benchmarks harness precedent) for one bank + one invoice + one
minutes turn.

---

## 8. Design recommendations — the shape of the fix

The 56 findings are symptoms of three design decisions that should change. Everything else is
incremental hardening.

### 8.1 Add the missing third mode: LLM over extracted, verified data
Today a question either hits a fixed template (no model) or raw chunks (no structure). The
extracted rows are small, deterministic, and already validated — hand them to the model:

```
question over tool-skill doc
  ├─ summary/reconcile/list-shaped  → deterministic template (as today, keep)
  ├─ format-shaped (json/csv/xml)   → serializer (as today; add bank parity)
  └─ anything else                  → grounded prompt over {header, rows, totals,
                                      validation} + "quote figures verbatim" rule
```

This resolves at a stroke: wrong-question templates (§3.1), byte-identical follow-ups, the
vendor/due-date gap, "groceries in March"-class questions, and it *shrinks* the keyword lists'
job — they select answer shape, not document access. The figures stay deterministic; the LLM only
narrates data that was parsed and validated. (The 4B model can misread even provided figures —
keep the templates for the high-stakes summary shapes, consider echoing key figures
deterministically under LLM answers, and reuse the D52 verify-against-source pattern when it lands.)

### 8.2 Invert the whole-doc gate: scope-shaped, not phrasing-shaped
When a skill is *explicitly active* over a single fully-chunked document, default to the
whole-document engine; use keywords only to opt out (off-topic small talk) and to distinguish
deliverable-asks from needle-asks (needle → top-k when whole-doc would truncate). Declare the
analysis mode in the manifest so instruction skills of any source get it. On doc-count mismatch,
route deterministically ("pick one statement…") instead of silently degrading. Make coverage
honesty *in-band*: the model is told about truncation, and the answer says it.

### 8.3 One trigger vocabulary, measured
Single bilingual per-skill vocabulary in code generating both the manifest triggers and the
routing gates, word-boundary matched, with a parity test and an 8-skill eval corpus that gates the
*suggestion* threshold too. Then — and only then — opt bank/invoice/meeting-protocol into
auto-fire with narrowed-scope doc signals, so the machinery reaches the users who never open the
picker.

### Priority order
| P | Theme | Items |
|---|---|---|
| **P0 — wrong figures/answers this week** | §5.2 label-prefix totals; §5.3 normalization pre-pass (U+2212/NBSP); §5.4 German totals labels; §5.1 compare direction; §5.6 stale-row exports; §5.5 sepa rule | small, isolated, each closes a confidently-wrong-output class; all need extractor version bumps + real-layout fixtures |
| **P1 — the complaint drivers** | §2.1 doc-count fallthrough notice/narrowing; §2.2 truncation notice + 1.5 divisor + de-overlap; §8.1 third mode; §3.2/§8.3 word-boundary + vocabulary unification | this is "skills analyze the whole doc and answer the actual question" |
| **P2 — reach & trust** | §2.4/§8.3 auto-fire expansion (after §4.4); §4.3 sticky-default UX; §3.3 bank format mode; coverage-badge/copy honesty (§2.3, ux items); du/Sie sweep |
| **P3 — pay down for skill №9** | §6.1 parameterized run seam; §6.2 self-describing tool registry; §6.4 shared handler plumbing; §7 eval infrastructure (start earlier if capacity allows — it de-risks P0/P1) |

---

## 9. Checked and cleared (so they aren't re-reported)
The adversarial pass **refuted** five plausible-sounding findings; for the record: the
summarize-cashflow button *does* surface figures via the routed-question relay (though §·ux-6's
multi-doc/plain-chat breakages of that relay are real and confirmed); the tool-skill fence does
not reference nonexistent material on the fallback path; sticky-default degradation and
skill-delete glyph behavior matched their documented contracts (the *silence* of degradation is
still flagged in §2.1/§4.3); and the analysis-handler "third tier" is deliberately placed at the
IPC layer with the plain-chat channel exempt by design (the *portability* consequence is §6.3).

## 10. Cross-references
- Prior audit: `architecture.md` §23 (2026-06-26) — remediated registry/lock/coverage items; this
  audit found no regression of its closed items.
- Open incidents this audit subsumes: BUILD_STATE INVOICE-TOTALS-1 "STILL OPEN" product call
  (→ §3.1/§8.1), COMPARE-DIFF-1 follow-ups (→ §2.2 compare fallback, §5.1).
- Accepted residuals judged **no longer acceptable** by this audit: template interception
  (BUILD_STATE:83-89), 4-skill eval corpus, ambiguous-date silence, line-item column debris
  (post-FORMAT-1).
