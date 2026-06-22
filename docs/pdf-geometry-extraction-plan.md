# PDF Geometry-Aware Extraction — plan (Phase 31)

_Status: **WORKING PAPER — not started (created 2026-06-22).** Branch `pdf-geometry-extraction`.
Motivated by a real user report: a German HypoVereinsbank ("HVB") bank statement analysed with the
`app:bank-statement` skill returned **zero transactions** ("Ich habe den ganzen Auszug gelesen, aber
keine Buchungen zum Summieren gefunden"). Root-cause investigation (this session) traced the failure
past the regex parser all the way to the PDF parser, which **discards the word coordinates it already
fetches**. Decision numbering continues the repo series after the full-doc-skills wave (D44–D49 →
**this plan D50–D55**). Per the CLAUDE.md doc-lifecycle rule this is a working paper: condense into a
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
| D51 | Where reconstruction lives | **Skill-owned re-parse path (Option B)** — the bank-statement/invoice skill re-reads the original PDF *at analysis time* with coordinates and reconstructs columns; **ingestion + RAG spine stay byte-unchanged.** | Threading x/y through `ExtractedSegment` → chunking → embeddings → citations touches the whole RAG spine (high blast radius). Option B localizes the change to the skill that needs it and preserves the R5 "relevance path unchanged" invariant. |
| D52 | Phasing + LLM gate | **Stage 1 (deterministic geometry) first; ship + measure.** Add the **Stage 2 LLM fallback only if** Stage-1 transaction recall on a real corpus is below a target (~90%), and then only on residual hard blocks. | The research bet (and ours): Stage 1 alone likely fixes HVB with **zero model calls**. Don't build the expensive path until the cheap one is measured to be insufficient. |
| D53 | Honesty for any LLM-emitted figure | Every LLM row must carry a `grounding_quote`; each `amount`/`date` is verified **verbatim** against the source page text (exact → numeric-token → fuzzy), then **balance-reconciled**. Any field that fails is **dropped, not guessed.** | Grammar makes output *parseable*, not *true*. Verbatim grounding + the existing running-balance reconciliation is the actual no-hallucination guarantee. Matches the §22-D1 drop-on-failure posture, now applied per field after the LLM pass. |
| D54 | Empty-result UX | Distinguish **"couldn't read this statement's layout"** from **"genuinely no transactions"**; never present an invented or silently-empty total. | Today a layout failure renders as an empty table on a statement full of bookings — looks broken/dishonest. Honest, actionable copy converts that into a real signal. |
| D55 | Stage-2 prerequisite | Before building Stage 2, **confirm our `node-llama-cpp` integration exposes JSON-schema / GBNF grammar-constrained decoding** and keep the grammar simple (CPU overhead). If unavailable, Stage 2 is re-scoped. | Stage 2's reliability rests on grammar-constrained, schema-shaped output; this is an unverified assumption in the current stack. |

**Hard rules (inherited, unchanged):** no cloud, no telemetry, offline forever; never invent a
figure (drop the ambiguous); no developer-absolute paths; Windows-first, macOS/Linux supported;
keep service boundaries clean; no new runtime dependency on the portable drive without justification
(D50 explicitly rejects the Python sidecar for this).

## 2. Root cause (the evidence)

The failure is **not** the regex parser I first suspected — that parser is fed already-scrambled
text. The chain:

1. [`parsers/pdf.ts:74-86`](../apps/desktop/src/main/services/ingestion/parsers/pdf.ts#L74-L86)
   calls `page.getTextContent()`, whose items carry `transform` (x/y) and `width`, but the loop keeps
   **only `item.str` + `hasEOL`**, concatenating with a space or newline in pdf.js *reading order*.
   The geometry — the one thing needed to rebuild columns — is discarded on the first pass.
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

### 3.1 New module — coordinate-aware re-parse (Option B, D51)

A skill-owned reader (proposed
`apps/desktop/src/main/services/skills/tools/pdf-layout.ts`) that, given a document's original PDF
path, returns **layout-preserved text** suitable for `extractTransactionRows`:

1. **Extract words with boxes.** Reuse `pdfjs-dist/legacy` (already a dependency); per item read
   `str`, `transform[4]` (x), `transform[5]` (y), `width`. (No new dependency — D50.)
2. **Cluster into rows** by y-coordinate within a tolerance band (handles sub-pixel jitter and
   superscripts).
3. **Cluster into columns** by x-gap / x-distribution on the page (date · description · amount).
   Right-align detection for the amount column.
4. **Propagate the page-header year** onto bare `DD.MM.` dates (scan the page's top band for a
   `YYYY` or a date range; fall back to the statement period if present).
5. **Merge multi-line descriptions** into the row whose y-band they fall in.
6. **Emit** either reconstructed single-line rows (`<date> <desc> <amount>` in the shape `parseLine`
   already expects) **or** a structured intermediate the parser consumes directly.

**Secondary deterministic path (optional):** a bundled `pdftotext -layout` (poppler) rendering as a
fallback for ruled/borderless tables. Defer unless Stage-1 JS clustering proves insufficient — it
adds a bundled binary (packaging cost) we'd rather avoid (consistent with D50's bias).

### 3.2 Parser tolerance (small, contained changes)

- [`parseDate`](../apps/desktop/src/main/services/skills/tools/money.ts#L98-L109): accept `DD.MM.`
  and `DD.MM.YY` **only when a year is supplied by the caller** (header propagation, §3.1.4) — never
  guess a year from nothing (honesty). Two-digit years resolved against the statement period.
- Keep `parseLine`/`extractTransactionRows` otherwise intact; they now receive clean rows.

### 3.3 Wiring

The bank-statement analysis handler currently extracts via `ctx.readDocumentSegments`
([`analysis/bank-statement.ts`](../apps/desktop/src/main/services/skills/analysis/bank-statement.ts)).
Add a coordinate-aware source for `.pdf` documents that have an on-disk original; fall back to the
existing segment text for non-PDFs or when the PDF path is unavailable. **No change to the chat
routing, the relevance path, or ingestion** (D51).

### 3.4 Stage-1 exit metric (gates D52)

Build a small corpus of **real German statements** (HVB, Sparkasse, ING, DKB) + a couple of invoices.
Measure **transaction recall** (extracted rows ÷ true rows) and **figure exact-match**. If
deterministic recall ≥ ~90%, Stage 2 may be unnecessary for these layouts — record the number and
stop.

## 4. Stage 2 — constrained LLM fallback (only if Stage 1 is insufficient, D52)

Prerequisite: **D55** confirmed (grammar-constrained decoding available in our `node-llama-cpp`).

1. **Trigger only on the hard subset:** a page/block where deterministic rows = 0 **or** balance
   reconciliation fails.
2. **Feed layout-preserved text** (the Stage-1 column-aligned output), not raw line-broken text.
3. **Constrain** to a simple JSON-schema/GBNF grammar requiring per row: `date`, `description`,
   `amount`, `currency`, **`grounding_quote`**. Keep the grammar simple (CPU overhead); set generous
   `maxTokens` (mid-JSON cutoff risk); describe the schema in the prompt too (the grammar is not
   injected into the prompt).
4. **Verification gate (D53):** confirm each `amount`/`date` appears **verbatim** in that page's
   source (exact → numeric-token → fuzzy); re-sum and reconcile against the printed running balance.
   **Drop any row/field that fails — never guess.**
5. **Merge** trusted deterministic rows + verified LLM rows; synthesize the answer as today.
6. **Latency hygiene:** LLM touches only the hard subset; chunk by page/block; stream; cache by a
   content hash of the block text.

## 5. Stage 3 — UX + honesty surfacing

- **D54:** when verification leaves blocks unparsed, surface a localized
  "**Ich konnte N Buchungen auf Seite X nicht zuverlässig lesen**" (EN parity) instead of the silent
  empty table — distinct from the genuine `skills.bankAnalysis.empty` (a statement that truly has no
  transactions). New i18n keys in `en.ts` + `de.ts` (parity).
- Keep the existing coverage badge honest (the `extract`/`fullyChunked` wording is already correct);
  ensure the "N sections scanned" count reflects what was actually read.

## 6. Tests + metrics (the per-phase ritual)

- **Unit:** geometry clustering (rows-by-y, columns-by-x), header-year propagation, multi-line merge,
  `parseDate` with supplied year. Pin behaviour on a synthetic **columnar** fixture (the current
  fixtures only test the already-clean single-line shape —
  [`skills-bank-statement-tool.test.ts:83-101`](../apps/desktop/tests/unit/skills-bank-statement-tool.test.ts#L83-L101)).
- **Integration:** a real-HVB-style PDF fixture through the `askDocuments` IPC → non-empty rows,
  correct totals, honest coverage, citations, 0 model calls (Stage 1).
- **Gold set (Stage-1 exit + Stage-3 harden):** 50–100 statements/invoices. Track: transaction
  recall, figure exact-match, reconciliation pass rate, **hallucinated-figure count (must be 0
  post-verification)**, p95 latency on a representative CPU (with the grammar enabled, if Stage 2).
- `npm test` green; app builds/launches; docs + `BUILD_STATE.md` updated; commit per phase
  (CLAUDE.md ritual).

## 7. Risks + mitigations

- **Hallucinated figures (cardinal risk):** mandatory verbatim grounding + balance reconciliation +
  drop-on-failure (D53). A number that isn't a verbatim substring of the source is never shown.
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
  [`tools/bank-statement.ts`](../apps/desktop/src/main/services/skills/tools/bank-statement.ts),
  [`tools/money.ts`](../apps/desktop/src/main/services/skills/tools/money.ts),
  [`analysis/bank-statement.ts`](../apps/desktop/src/main/services/skills/analysis/bank-statement.ts),
  [`analysis/coverage.ts`](../apps/desktop/src/main/services/analysis/coverage.ts).
- Topic docs to fold into on completion: [`architecture.md`](architecture.md) "Skills — design
  record" §8; [`known-limitations.md`](known-limitations.md) (parse-quality limitation);
  [`rag-design.md`](rag-design.md) (coverage, if touched).
- Prior art in-repo: the full-doc-skills wave (D44–D49) established the analysis-handler seam this
  plan extends.
