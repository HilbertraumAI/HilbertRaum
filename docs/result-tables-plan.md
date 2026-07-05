# Generic result tables — plan (result-tables wave)

_Status: **WORKING PAPER — Phases 1 + 1.5 + 1.6 implemented (2026-07-05); Phases 2–3 open.**
Per the CLAUDE.md doc-lifecycle rule this stays a standalone plan while work is open; once all
phases land (or are consciously dropped), condense into a design record folded into
`docs/architecture.md` ("Skills — design record") + `docs/rag-design.md` and delete this file.
Decision numbering continues the repo series after the invoice-hardening/whole-doc waves'
D44–D58 (**this plan: D59–D67**)._

---

## 1. The problem (observed failure, 2026-07-05)

User ask: _“Categorize all transactions and export them, including the category, as CSV.”_
Both halves exist — the bank-statement skill categorizes (persists
`bank_transactions.category_id`), and CSV export exists twice (the in-chat format answer and the
confirm-gated file export) — but the combination fails, in five distinct seams:

1. **`analysis/bank-statement.ts` format short-circuit** returns on the `csv` token BEFORE the
   categorization block runs — a “categorize … as CSV” turn never computes categories.
2. **`transactionsToCsv`** hardcodes seven columns; `TransactionInput` has no category field —
   neither CSV surface can carry a category even after a categorize run.
3. **`run.ts` `loadTransactions`** (the file-export lane’s row load) does not join
   `bank_categories` — the exporter’s input is category-less by construction.
4. **No chaining:** the chat handler never runs `export_transactions_csv` (by design — export
   stays confirm-gated); nothing decomposes “categorize AND export” into two steps.
5. **The no-skill route** classifies the ask as `relevance` (top-k), never whole-document.

The deeper diagnosis: **which rows** exist (extraction — already whole-document), **which
columns** the user wants, and **the deliverable** (inline vs file) are fused at compile time.
Every “but what if the user asks for X” failure (category, subcategory, both, German column
names, grouping) is the same failure. The general fix is a schema-driven pipeline:

> request → typed TableRequest → rows (deterministic) → derived columns (constrained LLM where
> semantic) → generic table → schema-agnostic serializer → inline render or confirm-gated export.

The runtime already supports the key enabler: grammar-constrained JSON output
(`runtime/llama.ts`, D55) — both the TableRequest parse (Phase 3) and per-row enrichment
(Phase 3) can be schema-forced, never free-text-parsed.

## 2. Decisions

| # | Decision | Lean | Why |
|---|---|---|---|
| D59 | General direction: schema-driven table pipeline | Separate rows / columns / deliverable; serializers take a `TableSpec` (columns + typed cells), never a fixed struct | Kills the whole class, not one prompt shape; generalizes to invoice line items, deadlines, extractions |
| D60 | `TableSpec` + `tableToCsv` live in `services/tables/` (pure, main-side) | One generic serializer; `transactionsToCsv` becomes a `TableSpec` builder + delegate | Both CSV surfaces (inline format answer, file export) reuse one audited serializer incl. the `csvField` formula-injection neutralization (S12 F4) |
| D61 | `TransactionInput` gains OPTIONAL `category?: string` (+ row schema) | The category travels WITH the row through the existing seams (`preloaded`, tool input, export) | Structural alignment (no index-matched parallel arrays crossing a seam); backward compatible — the extractor never emits it, tools that don’t read it are unaffected |
| D62 | The category column is **presence-gated**: emitted only when ≥1 row carries a category | Not an always-empty ninth column | Byte-identical CSV/JSON for every existing non-category flow (tests pin this); an empty `category` column would imply “categorized, all blank” — dishonest |
| D63 | On a category-shaped format ask the handler runs the categorize seam FIRST (persisting, `skill_runs` lifecycle intact), then serializes rows+categories; the honest `categoryAssisted` / `categoryRuleBased` note rides under the fenced block | Reuse the existing seed-once logic (deterministic pass when nothing persisted; persisted LLM categories reused, never overwritten) | A model-assigned category must never masquerade as a parser figure — the note the template path already uses carries the same honesty here |

## 3. Phase 1 — schema-agnostic serializer + category end-to-end (IMPLEMENTED, this wave)

Scope: the bank domain, both CSV surfaces, zero new model calls.

- **`services/tables/index.ts`** (new): `TableColumn { key, label, kind?: 'text'|'money'|'integer' }`,
  `TableSpec`, `tableToCsv()` — money cells fixed 2-dp dot-decimal, `csvField` neutralization on
  text, blank for null/undefined, `\r\n` + trailing newline (the existing CSV contract).
- **`skills/tools/bank-statement.ts`**: `TransactionInput.category?` (+ `TRANSACTION_ROW_SCHEMA`);
  `transactionsToCsv` builds a `TableSpec` (category column presence-gated, D62) and delegates;
  `statementToPlainObject` emits `category` per transaction under the same gate (JSON parity).
- **`skills/analysis/bank-statement.ts`**: the category block (seed-if-unpersisted + reload +
  `modelAssisted`) is hoisted ABOVE the format short-circuit; a category-shaped format ask
  serializes rows WITH their categories and appends the honest note (D63). Non-category format
  asks are byte-identical to before.
- **`skills/run.ts` `loadTransactions`**: LEFT JOIN `bank_categories`, carry `category` — the
  confirm-gated file export now includes the column whenever the statement has been categorized
  (button or chat lane), and stays byte-identical when it never was.

Explicitly NOT in Phase 1: chat-triggered file export (the export stays a confirm-gated UI
action; the chat answer’s inline CSV is copyable), the no-skill routing gap (§1 item 5), and any
new i18n keys (the existing `formatIntroCsv` + category notes compose).

## 3a. Phase 1.5 — user-defined category sets from the prompt (IMPLEMENTED, same day)

The user's follow-up: the rule pass is coarse, the fixed 15-label model taxonomy may not match
their buckets. “Kategorisiere in Miete, Lebensmittel, Kinder und Sonstiges …” now works end-to-end.

| # | Decision | Lean | Why |
|---|---|---|---|
| D64 | A custom set runs the enum-constrained categorizer **inline in the chat slot** | Not a doctask enqueue, not a new lane | The chat turn already holds the exclusive model slot (the same slot grounded-data streams in), so one llama-server is never hit twice; the answer arrives in the SAME turn. With **no runtime the ask is REFUSED** with friendly copy echoing the parsed set — the deterministic rules cannot know the user's labels, and a silent fixed-taxonomy fallback would answer a different question |
| D65 | The prompt parse is **conservative and all-or-nothing** | `parseRequestedCategories`: categorize stem + preposition, deliverable-tail cut (“… und exportiere als CSV”), ≥ 2 plausible labels (≤ 40 chars, ≤ 4 words), one bad token rejects the WHOLE parse | A half-understood list must never silently categorize into garbage; the refusal copy + the serialized output both echo the parsed labels so a mis-parse is immediately visible |

As built: `categorizer.ts` takes an optional `categories` list (per-run enum/prompt/validation;
prefilter skipped — its rule names are not the user's; `Uncategorized` always appended as the drop
target), `persistCategorization` (run.ts) persists assignments + the `categorized_by_model` flag
atomically, inserting user labels as NON-builtin `bank_categories` rows (looked up across all rows —
no duplicates); the handler REUSES a prior run when the persisted labels ⊆ the requested set (asking
for the CSV again is free), and `categoryLabel` no longer probes the i18n catalog with a user-defined
name (the catalog logs unknown keys — a custom category name is content and must not reach the
diagnostics log). `SkillAnalysisContext.runtime` is the one sanctioned model hook, threaded from
`registerRagIpc`.

## 3b. Phase 1.6 — taxonomy CSV referenced from the prompt (IMPLEMENTED, same day)

“Kategorisiere nach den Kategorien in `taxonomie.csv` …” — the taxonomy lives in an imported CSV
instead of the prompt line.

| # | Decision | Lean | Why |
|---|---|---|---|
| D66 | The referenced file is found by **name across the indexed library** — never by widening scope | `findDocumentByName`: case-insensitive title match (extension-stripped stems too), statement excluded, ties → most recently updated | The bank handler requires exactly ONE in-scope document (the statement); requiring the taxonomy in scope would break `applies()`. Lookup-only keeps the scope contract intact |
| D67 | The CSV’s second column is a per-label **GLOSS fed to the model prompt** (never persisted, never an enum value) | `Kinder;Schule, Kita, Taschengeld` → `- Kinder (Schule, Kita, Taschengeld)` in the system prompt | The fixed taxonomy’s accuracy on German statements rests on exactly this mechanism (its DE glosses); a keyword column is the single biggest quality lever for custom labels on a small model — and impossible to express in a one-line prompt |

As built: `parseTaxonomyFileRef` (categorize stem + a quoted-or-bare `.csv` token) and
`parseTaxonomyCsv` (one label per line, first-of-`;`/tab/`,` delimiter, header + `#`-comment skip,
gloss from the remaining cells, **all-or-nothing** like D65 — one bad label rejects the file; 2–40
labels). Missing file / unparseable list → honest refusals NAMING the file
(`customTaxonomyNotFound` / `customTaxonomyUnparseable`, EN+DE). The parsed set rides the existing
Phase-1.5 path (covered-check, no-runtime refusal, inline categorize, `persistCategorization`).
A FULL-PATH reference (`/home/…/taxonomie.csv`, `C:\…\buckets.csv`) is reduced to its basename
before the lookup (the library stores titles, not paths — and the app deliberately cannot READ an
arbitrary disk path: the file must be IMPORTED first). File labels accept the real-world shapes
`Kfz/Auto`, `Essen & Trinken`, `Vers. + Vorsorge` (wider than the inline parse, where those
characters signal a swallowed clause). Known caveats: with NO explicit scope, the chat layer’s
filename auto-scope may narrow the turn to the taxonomy file itself (the handler then falls through
to relevance — the feature wants the statement selected/in scope); filenames with spaces need
quotes; a taxonomy split across chunk boundaries is only a risk for files > one chunk (~500 tokens
≈ far beyond 40 labels).

## 4. Phase 2 — result-table artifact + message-level export (OPEN)

- Persist a generic `result_tables` row (columns + rows + provenance + coverage verdict) attached
  to the answer message whenever a handler produces a `TableSpec` — the generalization of
  `extraction_records`.
- Renderer: a message-level “Export CSV” affordance on any message carrying a table, dispatching
  into the EXISTING confirm-gated `saveTextFile` boundary with the table’s own columns. “Export”
  in chat becomes an operation on the previous result — the chaining gap (§1 item 4) closes
  without the handler ever writing a file.
- Retention/teardown: tables purge with their conversation/document (mirror
  `purgeSkillDataForDocument`).

## 5. Phase 3 — TableRequest parse + derived-column enrichment (OPEN)

- One grammar-constrained call (D55) parses the turn into
  `TableRequest { derivedColumns: [{name, description, enumValues?}], filter?, deliverable }`,
  replacing the format regexes as the LAST pipeline stage (the regex path stays as the offline /
  no-model fallback).
- Derived columns (subcategory, counterparty, …) fill via batched, schema-constrained per-row
  calls over the WHOLE extracted row set (whole-document by construction); enum-constrained where
  a taxonomy exists; a cell the model cannot determine is an explicit `unknown` — never guessed.
- Route no-skill tabular asks through extract-then-enrich instead of top-k relevance (§1 item 5).
- Latency posture mirrors the whole-doc map-reduce wave: progress notice + honest batch counts.

## 6. Risks / open questions

- **Small-model quality on free-form derived columns** (Phase 3) — mitigated by enum grammars +
  explicit `unknown`; needs an eval item before it ships.
- **`result_tables` size** (Phase 2) — cap rows per table (the `MAX_TRANSACTIONS`-style bound) and
  purge with the parent.
- **Invoice parity**: the invoice handler has the same format short-circuit shape; once Phase 1
  proves out, port the `TableSpec` delegation there (its serializers already share `csvField`).
