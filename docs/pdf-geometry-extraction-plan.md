# PDF Geometry-Aware Extraction — plan (Phase 31)

_Status: **WORKING PAPER — not started (created 2026-06-22).** Branch `pdf-geometry-extraction`.
Motivated by a real user report: a German HypoVereinsbank ("HVB") bank statement analysed with the
`app:bank-statement` skill returned **zero transactions** ("Ich habe den ganzen Auszug gelesen, aber
keine Buchungen zum Summieren gefunden"). Root-cause investigation (this session) traced the failure
past the regex parser all the way to the PDF parser, which **discards the word coordinates it already
fetches**. Decision numbering continues the repo series after the full-doc-skills wave (D44–D49 →
**this plan D50–D57**). Per the CLAUDE.md doc-lifecycle rule this is a working paper: condense into a
design record folded into [`architecture.md`](architecture.md) "Skills — design record" §8 (the
bank/invoice tools) + a note in [`known-limitations.md`](known-limitations.md), then **delete this
file** once implemented._

---

## 0. Background — corroborating research

A deep-research review (Claude web, with web sources) independently reached the same conclusion this
plan is built on: the state of the art for document → structured-data extraction has converged on
**layout/geometry first, then text**, with an LLM used only as a *verified fallback on the hard
subset* — never as the source of truth for figures. Two findings that directly shape the decisions
below:

- **Layout, not model size, is the dominant lever.** Pure text-only PDF parsing scrambles columnar
  documents regardless of how good the downstream model is. Reconstructing rows/columns from word
  coordinates recovers most transactions with **no model at all**.
- **A Python sidecar is not warranted for this problem.** The usual argument for Python (mature
  coordinate APIs: pdfplumber/camelot) does not apply to us: **we already ship `pdfjs-dist`, and the
  coordinates are already in the object we iterate** — we just throw them away. Paying the
  portable-USB bundle-size, code-signing, and second-runtime-to-verify costs to access
  column-clustering we can write in ~100 lines of TS would be a bad trade. (A Python sidecar remains
  a separate, later question for unrelated needs — pandas-class analysis, heavier OCR — not this one.)

## 1. Summary (the decisions)

| # | Decision | Lean | Why |
|---|---|---|---|
| D50 | Architecture direction | **Hybrid, Node-native.** Deterministic geometry-first extraction; constrained local-LLM only as a verified fallback. **No Python sidecar.** | We already have `pdfjs-dist`; the gap is discarded data, not a missing ecosystem. Offline/portable/privacy constraints all favour staying in-process. |
| D51 | Where reconstruction lives | **A layout MODE of the existing PDF parser, reached through the existing re-parse seam** — NOT a new standalone reader. The skill already re-parses the original PDF at analysis time via [`extractDocumentPreview`](../apps/desktop/src/main/services/ingestion/index.ts#L887-L958) (the `readDocumentSegments` closure). Thread a `layout` flag through `ParseContext` → `PdfParser.parse()`; **ingest keeps the default text mode, so chunking/embeddings/citations stay byte-unchanged.** | A standalone reader taking "the original PDF path" CANNOT work in an encrypted workspace — there is no plaintext path; the bytes exist only as a transient that `extractDocumentPreview` decrypts and shreds. Forking that would miss the cipher and duplicate security-sensitive code. Reusing the parse seam preserves the R5 "relevance path unchanged" invariant AND the decrypt/OCR/shred/page-cap machinery. |
| D52 | Phasing + LLM gate | **Stage 1 (deterministic geometry) first; ship + measure.** Add the **Stage 2 LLM fallback only if** Stage-1 transaction recall on the (local-only, D57) corpus is below a target (~90%), and then only on residual hard blocks. | The research bet (and ours): Stage 1 alone likely fixes HVB with **zero model calls**. Don't build the expensive path until the cheap one is measured to be insufficient. |
| D53 | Honesty for any LLM-emitted figure | Every LLM row must carry a `grounding_quote`; each `amount`/`date` is verified **verbatim** against the source page text (exact → numeric-token → fuzzy), then **balance-reconciled**. Any field that fails is **dropped, not guessed.** | Grammar makes output *parseable*, not *true*. Verbatim grounding + the existing running-balance reconciliation is the actual no-hallucination guarantee. Matches the §22-D1 drop-on-failure posture, now applied per field after the LLM pass. |
| D54 | Empty-result UX | Distinguish **"couldn't read this statement's layout"** from **"genuinely no transactions"**; never present an invented or silently-empty total. Wire the new copy into the **existing** "could not be read" seam in [`resolveDocumentReader`](../apps/desktop/src/main/services/skills/run.ts#L93-L114), not a parallel flow. | Today a layout failure renders as an empty table on a statement full of bookings — looks broken/dishonest. Honest, actionable copy converts that into a real signal. |
| D55 | Stage-2 prerequisite | Stage 2 needs **grammar-constrained decoding over our `llama-server` HTTP sidecar** (a GBNF/`json_schema` field on the `/v1/chat/completions` request) — **NOT** `node-llama-cpp`, which we do not use. Our runtime seam (`LlamaRuntime`/`sidecar.ts`) **does not expose a grammar/`response_format` path today**, so Stage 2 includes new runtime plumbing. Keep the grammar simple (CPU overhead). | The stack is a spawned `llama-server` binary over loopback, not an in-process library; constrained decoding must be plumbed through the request path that does not yet carry it. |
| D56 | No partial totals (completeness gate) | Stage 1 must run a **completeness check before presenting any total**: reconcile the extracted row sum against the printed **opening→closing balance** (or detect row-count/running-balance gaps). If completeness cannot be **proven**, **downgrade to the D54 "couldn't fully read" message** — never sum a partial set and present it as the total. | Partial extraction (e.g. 17 of 20 rows) is MORE dangerous than today's empty result: it yields a confident WRONG total — exactly the harm the honesty rule forbids. The ~90% recall target (D52) explicitly tolerates missing rows, so the answer path must independently prove completeness, not assume it. |
| D57 | Evaluation corpus location | The real-statement gold set is **LOCAL-ONLY / gitignored**, run via a manual harness (the `PAID_*`-style smoke pattern). Only **aggregate metrics** are committed — never a statement, fixture, or excerpt. | Real bank statements are user financial data; committing them violates the CLAUDE.md "never commit user data" hard rule. |

**Hard rules (inherited, unchanged):** no cloud, no telemetry, offline forever; never invent a
figure (drop the ambiguous); no developer-absolute paths; Windows-first, macOS/Linux supported;
keep service boundaries clean; no new runtime dependency on the portable drive without justification
(D50 explicitly rejects the Python sidecar for this).

## 2. Root cause (the evidence)

The failure is **not** the regex parser I first suspected — that parser is fed already-scrambled
text. Note the skill is fed **newline-preserving parser segments** (via
[`extractDocumentPreview`](../apps/desktop/src/main/services/ingestion/index.ts#L887-L958), NOT the
overlapping `chunks` table — [`run.ts` `resolveDocumentReader`](../apps/desktop/src/main/services/skills/run.ts#L93-L114)
is explicit that chunks are the wrong source). So the defect is narrower than "newline collapse": even
with newlines preserved, the parser does not reconstruct **columns**. The chain:

1. [`parsers/pdf.ts:74-86`](../apps/desktop/src/main/services/ingestion/parsers/pdf.ts#L74-L86)
   calls `page.getTextContent()`, whose items carry `transform` (x/y) and `width`, but the loop keeps
   **only `item.str` + `hasEOL`**, concatenating with a space or newline in pdf.js *reading order*.
   The geometry — the one thing needed to rebuild columns — is discarded on the first pass. (This same
   `PdfParser.parse()` runs at BOTH ingest and the skill's analysis-time re-parse.)
2. A columnar HVB statement (date column · booking text · amount column, right-aligned) therefore
   arrives downstream as interleaved/merged lines, not visual rows.
3. [`tools/bank-statement.ts` `parseLine`](../apps/desktop/src/main/services/skills/tools/bank-statement.ts#L75-L97)
   requires each transaction to be **one line that starts with a full date token and carries the
   amount on the same line**. Almost no row survives.
4. [`money.ts` `parseDate`](../apps/desktop/src/main/services/skills/tools/money.ts#L98-L109) accepts
   only 4-digit-year dates; real statements print `DD.MM.` / `DD.MM.YY` with the year in the page
   header → dropped.
5. `extractTransactionRows` returns `[]` → [`buildBankAnswer`](../apps/desktop/src/main/services/skills/analysis/bank-statement.ts#L224)
   hits `rows.length === 0` → `skills.bankAnalysis.empty`. Exactly the user's screenshot.

## 3. Stage 1 — deterministic geometry reconstruction (do first)

**Goal:** recover transactions from digital (text-layer) statements with **zero model calls**, by
rebuilding visual rows/columns from word coordinates before the existing pure parser runs.

### 3.1 Parser layout-mode — coordinate-aware reconstruction (D51)

A **layout mode of the existing `PdfParser`**, reached through the existing decrypt/OCR/shred seam —
**not** a new standalone reader (D51 rationale). Add an opt-in `layout` flag to `ParseContext`; when
set, `PdfParser.parse()` returns **layout-preserved text** suitable for `extractTransactionRows`:

1. **Extract words with boxes.** Already inside `PdfParser.parse()`: `page.getTextContent()` items
   carry `str`, `transform[4]` (x), `transform[5]` (y), `width`. Today only `str`/`hasEOL` are kept;
   in layout mode keep the coordinates too. (No new dependency — D50.)
2. **Cluster into rows** by y-coordinate within a tolerance band (handles sub-pixel jitter and
   superscripts).
3. **Cluster into columns** by x-gap / x-distribution on the page (date · description · amount).
   Right-align detection for the amount column.
4. **Propagate the page-header year** onto bare `DD.MM.` dates (scan the page's top band for a
   `YYYY` or a date range; fall back to the statement period if present).
5. **Merge multi-line descriptions** into the row whose y-band they fall in.
6. **Emit** either reconstructed single-line rows (`<date> <desc> <amount>` in the shape `parseLine`
   already expects) **or** a structured intermediate the parser consumes directly.

**Page cap:** layout mode must honor the same `ctx.maxPages` cap the ingest path applies (security
audit M-2). The current preview/skill parse passes no cap
([`index.ts:941-944`](../apps/desktop/src/main/services/ingestion/index.ts#L941-L944)); adding
per-page clustering across an uncapped page count is a DoS/perf amplifier, so thread the cap through.

**Secondary deterministic path (optional):** a bundled `pdftotext -layout` (poppler) rendering as a
fallback for ruled/borderless tables. Defer unless Stage-1 JS clustering proves insufficient — it
adds a bundled binary (packaging cost) we'd rather avoid (consistent with D50's bias). If ever added,
it must write only through the shredded-transient discipline (no plaintext outside the transient).

### 3.2 Parser tolerance (NON-BREAKING; `parseDate` is shared)

`parseDate` is shared by **bank-statement, invoice** (`parseDateInText`,
[`invoice.ts:155`](../apps/desktop/src/main/services/skills/tools/invoice.ts#L155)) **and redaction**
([`redaction.ts:154`](../apps/desktop/src/main/services/skills/tools/redaction.ts#L154) — a privacy
feature that masks dates). Relaxing it in place would silently change invoice date-picking and what
redaction masks.

- **Leave `parseDate`'s current behavior unchanged.** Add the `DD.MM.`/`DD.MM.YY` capability as a
  **separate function or an opt-in param defaulting to today's behavior**, called only from the
  layout-mode bank path with a year supplied by the caller (header propagation, §3.1.4) — never guess
  a year from nothing (honesty). Two-digit years resolved against the statement period.
- **Regression tests are mandatory:** assert invoice extraction and redaction masking are
  byte-unchanged by this work (§6).
- Keep `parseLine`/`extractTransactionRows` otherwise intact; they now receive clean rows.

### 3.3 Wiring

The bank-statement analysis handler already extracts via `ctx.readDocumentSegments` →
`extractDocumentPreview` → `PdfParser.parse()`. Wiring is: pass `layout: true` down that existing
path for the bank/invoice skills on `.pdf` documents; everything else (non-PDF, OCR'd image-only
PDFs that have no text layer → fall back to stored recognition, encrypted-with-no-cipher → the
existing "could not be read" refusal) is **already handled** by `extractDocumentPreview` /
`resolveDocumentReader`. **No change to the chat routing, the relevance path, or ingestion** (D51).

### 3.4 Stage-1 exit metric (gates D52)

Using the **local-only** corpus (D57 — real German statements: HVB, Sparkasse, ING, DKB + a couple
of invoices; never committed), measure **transaction recall** (extracted rows ÷ true rows) and
**figure exact-match**, plus the **completeness-gate pass rate** (D56). If deterministic recall ≥ ~90%
AND the completeness gate reliably catches the shortfall on the rest, Stage 2 may be unnecessary for
these layouts — record the numbers and stop.

## 3.5 Completeness gate (D56 — do NOT present partial totals)

Stage 1 is not done when it recovers *some* rows — it is done when it can **prove** it recovered
*all* of them, or honestly say it could not. Before [`buildBankAnswer`](../apps/desktop/src/main/services/skills/analysis/bank-statement.ts#L214)
sums anything:

1. **Reconcile against the printed opening→closing balance** when present: `opening + Σamounts ==
   closing` (within `MONEY_EPS`). If it ties out, the set is provably complete → present the total.
2. **Detect gaps** when a per-line running balance is present (a broken `balanceAfter[i-1] + amount ==
   balanceAfter[i]` chain means a row is missing) — the existing `reconcileBalances` already computes
   this; surface it as a completeness signal, not just a per-row flag.
3. **When completeness cannot be proven** (no opening/closing balance, no per-line balance, or a
   detected gap), **downgrade to the D54 "couldn't fully read N rows" message** — do not emit a total,
   a category breakdown, or a net figure from an unverified-complete set.

This is the single most important safety property of the plan: a partial read must degrade to honesty,
never to a confident wrong total.

## 4. Stage 2 — constrained LLM fallback (only if Stage 1 is insufficient, D52)

Prerequisite: **D55** — grammar-constrained decoding plumbed through our **`llama-server` HTTP
sidecar** (a GBNF/`json_schema` field on the `/v1/chat/completions` request). We do **not** use
`node-llama-cpp`; the runtime seam (`LlamaRuntime`/`sidecar.ts`) does not expose a grammar path today,
so this step includes new runtime plumbing.

1. **Trigger only on the hard subset:** a page/block where deterministic rows = 0 **or** the
   completeness gate (§3.5) could not prove completeness.
2. **Feed layout-preserved text** (the Stage-1 column-aligned output), not raw line-broken text.
3. **Constrain** via a simple GBNF/`json_schema` request field requiring per row: `date`,
   `description`, `amount`, `currency`, **`grounding_quote`**. Keep the grammar simple (CPU overhead);
   set a generous token budget (mid-JSON cutoff risk); describe the schema in the prompt too (the
   grammar constrains output, it is not injected into the prompt).
4. **Verification gate (D53):** confirm each `amount`/`date` appears **verbatim** in that page's
   source (exact → numeric-token → fuzzy); re-sum and reconcile against the printed running balance.
   **Drop any row/field that fails — never guess.**
5. **Merge** trusted deterministic rows + verified LLM rows; synthesize the answer as today.
6. **Latency hygiene:** LLM touches only the hard subset; chunk by page/block; stream; cache by a
   content hash of the block text.

## 5. Stage 3 — UX + honesty surfacing

- **D54:** when the completeness gate (§3.5) or verification leaves blocks unparsed, surface a
  localized "**Ich konnte N Buchungen auf Seite X nicht zuverlässig lesen**" (EN parity) instead of
  the silent empty table — distinct from the genuine `skills.bankAnalysis.empty` (a statement that
  truly has no transactions). New i18n keys in `en.ts` + `de.ts` (parity); wire through the existing
  "could not be read" seam in `resolveDocumentReader`, not a parallel flow.
- **Coverage honesty (unit mismatch):** `computeCoverage` currently counts the `chunks` table
  ([`coverage.ts` `documentChunkCount`](../apps/desktop/src/main/services/analysis/coverage.ts#L33-L38)),
  while extraction reads parser **segments** — different units, so "N Abschnitte durchsucht" can
  misstate what was read. Decide and document the unit the badge reports post-change (align it to the
  segments actually scanned, or keep chunks and reword), so the count stays truthful. The
  `extract`/`fullyChunked` wording itself is already correct.

## 6. Tests + metrics (the per-phase ritual)

- **Unit:** geometry clustering (rows-by-y, columns-by-x), header-year propagation, multi-line merge,
  the new year-aware date parse, and the §3.5 completeness gate. Pin behaviour on a **synthetic
  columnar** fixture (the current fixtures only test the already-clean single-line shape —
  [`skills-bank-statement-tool.test.ts:83-101`](../apps/desktop/tests/unit/skills-bank-statement-tool.test.ts#L83-L101)).
- **Fixture mechanism (decide up front):** a real-HVB-style PDF with *positioned* text can't be
  hand-written. Generate a columnar PDF in-test with a devDependency (`pdfkit`/`pdf-lib`) or commit a
  tiny **synthetic** fixture. It MUST be synthetic — never a real statement (D57 / privacy).
- **Regression (do-no-harm):** explicit tests that **invoice extraction and redaction masking are
  byte-unchanged** by the `parseDate` work (§3.2), and that the relevance path stays byte-unchanged
  for off-topic/multi-doc turns (R5).
- **Integration:** the synthetic columnar PDF fixture through the `askDocuments` IPC → non-empty rows,
  correct totals, honest coverage, citations, 0 model calls (Stage 1); plus a partial-extraction
  fixture that MUST trigger the D56 downgrade (no total emitted).
- **Gold set (Stage-1 exit + Stage-3 harden) — LOCAL-ONLY (D57):** 50–100 real statements/invoices,
  gitignored, run via a manual `PAID_*`-style harness; only aggregate metrics committed. Track:
  transaction recall, figure exact-match, completeness-gate pass rate, reconciliation pass rate,
  **hallucinated-figure count (must be 0 post-verification)**, **partial-total-presented count (must
  be 0 — D56)**, p95 latency on a representative CPU (with the grammar enabled, if Stage 2).
- `npm test` green; app builds/launches; docs + `BUILD_STATE.md` updated (including the shared-
  `parseDate` non-breaking decision); commit per phase (CLAUDE.md ritual).

## 7. Risks + mitigations

- **Partial totals (cardinal risk, NEW):** Stage 1 recovering *some* rows yields a confident WRONG
  total — worse than today's empty result. Mitigated by the §3.5 completeness gate (D56): no total is
  presented unless completeness is proven, else honest downgrade. Tested by a partial-extraction
  fixture + the "partial-total-presented count = 0" metric.
- **Hallucinated figures (cardinal risk):** mandatory verbatim grounding + balance reconciliation +
  drop-on-failure (D53). A number that isn't a verbatim substring of the source is never shown.
- **Shared-`parseDate` regression:** changing date parsing could alter invoice picking + redaction
  masking. Mitigated by a non-breaking additive change (§3.2) + invoice/redaction regression tests.
- **Grammar = false confidence:** valid JSON ≠ correct JSON; always pair with grounding (D53).
- **Reformatting may not help a generic small model** (the LayIE-LLM counter-evidence): treat column
  reconstruction primarily as a *deterministic* win; only assume an LLM benefit after measuring on our
  data.
- **Column clustering is heuristic:** statements vary wildly. Mitigate with the gold-set corpus and
  the `pdftotext -layout` secondary path held in reserve.
- **Scanned (image-only) statements** are out of scope here — they go through the existing OCR path
  ([`ocr/pipeline.ts`](../apps/desktop/src/main/services/ocr/pipeline.ts)); a small local VLM is a
  last resort, not part of this plan.
- **Packaging:** no new runtime deps for Stage 1 (D50). If `pdftotext` is ever added, it follows the
  existing verified-sidecar discipline (SHA-256 before spawn) and Windows-first packaging tests.

## 8. References

- Investigation (this session): root cause + the discarded-coordinates finding.
- Code: [`parsers/pdf.ts`](../apps/desktop/src/main/services/ingestion/parsers/pdf.ts),
  [`ingestion/index.ts` `extractDocumentPreview`](../apps/desktop/src/main/services/ingestion/index.ts#L887-L958),
  [`skills/run.ts` `resolveDocumentReader`](../apps/desktop/src/main/services/skills/run.ts#L93-L114),
  [`tools/bank-statement.ts`](../apps/desktop/src/main/services/skills/tools/bank-statement.ts),
  [`tools/money.ts`](../apps/desktop/src/main/services/skills/tools/money.ts),
  [`tools/invoice.ts`](../apps/desktop/src/main/services/skills/tools/invoice.ts),
  [`tools/redaction.ts`](../apps/desktop/src/main/services/skills/tools/redaction.ts),
  [`analysis/bank-statement.ts`](../apps/desktop/src/main/services/skills/analysis/bank-statement.ts),
  [`analysis/coverage.ts`](../apps/desktop/src/main/services/analysis/coverage.ts),
  runtime: `services/runtime/sidecar.ts` / `llama.ts` (`llama-server` HTTP — D55).
- Topic docs to fold into on completion: [`architecture.md`](architecture.md) "Skills — design
  record" §8; [`known-limitations.md`](known-limitations.md) (parse-quality limitation);
  [`rag-design.md`](rag-design.md) (coverage, if touched).
- Prior art in-repo: the full-doc-skills wave (D44–D49) established the analysis-handler seam this
  plan extends.
