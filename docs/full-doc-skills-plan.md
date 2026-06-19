# Full-document analysis for tool skills — plan

_Status: **WORKING PAPER — not started (created 2026-06-19).** Branch
`fix-use-full-doc-for-skills`. Triggered by an MVP test report: a user ran the **Kontoauszug-Analyse**
(`bank-statement`) skill in chat and got an answer badged "Basiert auf den relevantesten Passagen —
nicht auf dem ganzen Dokument" (the `coverage.relevance` meter). The answer was honest but **partial**
— a bank statement was analysed from ~5 retrieved passages, not the whole document. For accounting,
partial means wrong totals._

_Per the CLAUDE.md doc-lifecycle rule this is a working paper: once implemented, condense into a
design record folded into [`architecture.md`](architecture.md) ("Skills — design record") with the
coverage half cross-linked from [`rag-design.md`](rag-design.md) §14, then delete this file. Decision
numbering continues the repo's global series after the big-slot plan's D38–D43 → **D44–D49 here**._

---

## 1. The decisions (locked with the user 2026-06-19)

| # | Decision | Choice | Why |
|---|---|---|---|
| D44 | Scope of the fix | **General `kind:tool` mechanism**, not a bank-only patch | The bug is a class (any tool skill's correctness guarantees are bypassed on the chat path), not one instance. Bank-statement is the first adopter + the test case. |
| D45 | When a doc can't be analysed exhaustively (not fully chunked / too large) | **Refuse the partial answer; require the full run** | An accounting answer that silently omits transactions is worse than a clear "I can't do this exhaustively yet — index/re-run." Honesty posture §22-D1. |
| D46 | Auto-running the skill's read-only tools on a plain chat question | **Yes — auto-run read-only tools** (export stays confirm-gated) | Read-only, deterministic, no side effects. A plain question should give exhaustive results without an extra click. Changes today's "tools run only when the user starts them" contract for **read-only** tools only. |
| D47 | How the exhaustive answer is produced | A **per-skill analysis handler** runs the whole-document tools, then the answer is **synthesised from the structured result** (the compact extracted table), not from raw document chunks | The extracted transaction table is far smaller than the raw statement and fits context trivially. "Analyse the full document" = route through the whole-doc tools, **never** prompt-stuff every chunk. |
| D48 | Coverage meter | Stop **hardcoding** `mode:'relevance'`; persist a real `CoverageInfo` per message and render the truth | The renderer currently shows the relevance label for *every* citation-bearing answer ([`Transcript.tsx:217`](../apps/desktop/src/renderer/chat/Transcript.tsx#L217)). Requirement 1 ("if we analysed the full document, show that") is *impossible* until the meter is data-driven. |
| D49 | Which skills opt in now | `bank-statement` ships an analysis handler in this work; `invoice` follows the same seam (fast follow); `document-redaction` does **not** (it is an action skill, not an analysis-question skill) | The seam is general; adoption is per-skill so a skill without a meaningful "analyse this doc" answer is never force-routed. |

**Hard rules (inherited, unchanged):** no cloud / no telemetry; the model is never called without
grounding; tools keep the §14 capability ceiling (frozen single-doc scope, `readDocumentChunks` the
only content reach); export is confirm-gated and the FS write stays in the seam; honest copy in UI;
EN + DE for every new string; no partial persist (a failed run rolls back).

---

## 2. The problem, precisely (what the code does today)

The screenshot is a **normal RAG chat answer with a skill fence attached**, *not* a run of the skill's
tools. Trace:

1. [`registerRagIpc.ts`](../apps/desktop/src/main/ipc/registerRagIpc.ts) resolves the turn skill
   ([`resolveTurnSkill`](../apps/desktop/src/main/services/skills/turn.ts#L36)) — a sticky default or
   an S13 auto-fire. This yields only `{ installId, title, body }` (the SKILL.md prose), **nothing
   about the skill's tools.**
2. [`routeQuestion`](../apps/desktop/src/main/services/analysis/router.ts#L87) classifies the text.
   A bank question rarely matches `coverage-extract` ("list every / how many") or `tree-summary`
   ("summarize / overview"), so it falls through to **`relevance`**.
3. [`generateGroundedAnswer`](../apps/desktop/src/main/services/rag/index.ts#L457) runs **top-k
   retrieval** (the 5 "Quellen") and injects the SKILL.md body as a prompt **fence**
   ([`rag/index.ts:503`](../apps/desktop/src/main/services/rag/index.ts#L503)). The model answers from
   those passages.
4. The renderer **hardcodes** `mode:'relevance'` for any citation-bearing answer
   ([`Transcript.tsx:217`](../apps/desktop/src/renderer/chat/Transcript.tsx#L217)) → the badge.

Meanwhile the skill **already ships deterministic whole-document tools** that read *every* chunk:
[`extract_transactions`](../apps/desktop/src/main/services/skills/tools/bank-statement.ts#L127),
`summarize_cashflow`, `validate_statement_balances`, `categorize_transactions`. The app-orchestrated
run seam [`runBankExtraction`](../apps/desktop/src/main/services/skills/run.ts) already drives them
over the **faithful** `readDocumentSegments` reader (newline-preserving parser segments — the *correct*
source, vs the overlap-collapsing `chunks` table). But that seam is only reachable from an explicit
user action (a button / doc-action), never from a chat question.

**Net:** a `kind:tool` skill's exhaustive, deterministic guarantees are bypassed the moment the user
just *asks* about the document. The badge is honest about it; the analysis is still partial.

### Why the naive fixes are wrong
- *"Make the badge say full document."* Dishonest — violates H7 ([`known-limitations.md:238`](known-limitations.md)).
  The label can only change once the analysis changes.
- *"Stuff every chunk into the prompt."* Top-k RAG exists *because* large docs overflow the context
  window. The fix must route through the whole-doc **tools**, whose structured output is small (D47).

---

## 3. Design

### 3.1 The seam: a per-skill analysis handler

Add an **analysis-handler registry** (main): a map keyed by skill `install_id` (or skill `id`) →
an async handler

```ts
interface SkillAnalysisHandler {
  /** Can this skill answer THIS question exhaustively over THIS scope? (cheap, pre-flight) */
  applies(input: { question: string; scope: RetrievalScope; db: Db }): boolean
  /** Run the whole-document read-only tools and synthesise the grounded answer + real coverage. */
  run(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult>
}

interface SkillAnalysisResult {
  answer: string            // synthesised from the structured tool output (D47)
  citations: Citation[]     // real source chunks behind the figures (M2-safe)
  coverage: CoverageInfo    // extract/whole — the honest breadth (D48)
}
```

The handler is the bridge between the existing tool seam (`run.ts`) and the chat router. It reuses
`runBankExtraction`'s machinery (the `readDocumentSegments` faithful reader, the S10 gate, the
audit/`skill_runs` lifecycle) — auto-running the **read-only** tools (D46). It must NOT run
`export_transactions_csv` (export tier stays confirm-gated; never auto-fires).

`bank-statement`'s handler: `extract_transactions` → `summarize_cashflow` +
`validate_statement_balances` (+ `categorize_transactions` when the question is category-shaped) →
build a deterministic answer that follows [`SKILL.md`](../app-skills/bank-statement/SKILL.md): quote
the printed figures, show count + totals + net, surface unreconciled/uncertain rows **before** the
total, never invent a number. The answer is mostly deterministic copy; an optional grounded LLM pass
may phrase it, but the **figures come from the tools**, not the model.

### 3.2 Routing change

In [`registerRagIpc.ts`](../apps/desktop/src/main/ipc/registerRagIpc.ts), after the turn skill
resolves and before `generateGroundedAnswer`:

```
if skill is kind:tool AND a registered handler.applies(question, scope):
    docs ← documentsInScope(scope)
    if NOT every doc in scope is fully_chunked:        # exhaustiveness precondition (D45)
        return REFUSE answer  →  honest message + a "re-index / run full analysis" action
    result ← handler.run(...)                          # auto-run read-only tools (D46)
    persist assistant message with result.answer, result.citations, result.coverage
else:
    fall through to generateGroundedAnswer  (BYTE-UNCHANGED relevance path)
```

`applies()` keeps the change surgical: only a tool skill **with** a handler **and** an analysis-shaped
question is re-routed; everything else (including a tool skill answering an off-topic question) keeps
the existing relevance path verbatim. The single locked-slot contract is preserved by acquiring the
chat slot exactly as the coverage-extract branch does.

#### Exhaustiveness precondition (D45)
`fully_chunked` is the same invariant the deep-index / extract pass already requires
([`known-limitations.md:249`](known-limitations.md)). A scope where any in-scope doc is not fully
chunked (legacy index) cannot be analysed exhaustively, so we **refuse**: a fixed, localized answer
("I can't analyse the whole statement yet — it needs to be fully indexed") plus the existing re-index
affordance. No model call, no partial answer. (A future phase may auto-trigger the re-index; for now
it is surfaced, not silent.)

### 3.3 Coverage becomes data-driven (D48)

Today `CoverageInfo` is computed for summaries but **not** persisted on chat messages, and the
renderer hardcodes `relevance`. Make it real:

- **Schema:** add `coverage_json TEXT` to `messages` via the additive `ensureColumn` migration
  ([`db.ts:565`](../apps/desktop/src/main/services/db.ts#L565) is the precedent). Nullable; old rows =
  NULL.
- **Persist:** `appendMessage` gains an optional `coverage?: CoverageInfo`. The skill-analysis path
  stamps an `extract`/`whole` coverage (`coverage.extract.whole` — "Jeder Treffer im ganzen Dokument —
  N Abschnitte durchsucht", reusing existing i18n). The plain relevance path stamps `mode:'relevance'`
  explicitly (making today's hardcoded label *true* and *recorded*, not assumed).
- **Render:** [`Transcript.tsx`](../apps/desktop/src/renderer/chat/Transcript.tsx) uses `m.coverage`
  when present; **falls back** to `{ mode:'relevance' }` when NULL so every pre-migration message and
  the unchanged relevance path render exactly as before (zero visual regression).

This is what makes requirement 1 ("if we analysed the full document, show that") actually expressible.

### 3.4 The honesty edges
- A skill answer is `extract`/`whole` **only** when every in-scope doc was fully chunked AND every
  chunk was read by the tool. Any parse gaps surface as the existing `…wholeUnparsed` / `…sections`
  variants ([`CoverageMeter.tsx`](../apps/desktop/src/renderer/components/CoverageMeter.tsx#L47)) — we
  never upgrade a gappy run to a clean "whole document."
- Citations remain real source chunks (never the synthesised total) — M2.
- Refuse copy is content-free and friendly; the technical reason stays in the seam's log.

---

## 4. Phased delivery (per-phase ritual each: tests green · app builds · docs · BUILD_STATE · commit)

### Phase 1 — Data contract (coverage on messages) ✅ DONE (2026-06-19)
- `messages.coverage_json` migration (`ensureColumn`); `Message.coverage?: CoverageInfo` in
  [`shared/types.ts`](../apps/desktop/src/shared/types.ts); read/write in
  [`chat.ts`](../apps/desktop/src/main/services/chat.ts) (`rowToMessage` + `appendMessage`).
- Renderer: [`Transcript.tsx`](../apps/desktop/src/renderer/chat/Transcript.tsx) reads
  `m.coverage ?? { mode:'relevance', chunksCovered:0, chunksTotal:0 }`.
- Tests: round-trip persistence; malformed/legacy `coverage_json` → undefined; NULL → relevance
  fallback renders unchanged (existing Transcript test) + a data-driven `extract` coverage renders.
- **No behaviour change** — pure plumbing landed first. Suite 1792 green; typecheck + build clean.
- **As built:** `appendMessage` gained `coverage?: CoverageInfo | null` → `serializeCoverage`
  (tolerant: a stringify fault degrades to NULL, never blocks the append). `rowToMessage` →
  `parseCoverage` (NULL/malformed → undefined; required keys coalesced so a partial payload still
  satisfies the contract). The relevance path persists no coverage (stays NULL), so every existing
  and pre-migration message renders byte-identically via the renderer fallback (R5).

### Phase 2 — The analysis-handler seam + bank handler ✅ DONE (2026-06-19)
- `services/skills/analysis/` — the handler registry + `SkillAnalysisHandler` types; reuse
  `runBankExtraction` machinery. Bank handler: extract → summarize → reconcile (+ categorize) →
  deterministic answer builder honouring SKILL.md; emits `{ answer, citations, coverage }`.
- Auto-run read-only tools only (export excluded by construction).
- Unit tests: exhaustive math (totals/net/count), unreconciled rows surfaced before totals, mixed
  currency reported as no-total, figures quoted not invented, export never auto-run.
- **As built:** new module [`apps/desktop/src/main/services/skills/analysis/`](../apps/desktop/src/main/services/skills/analysis/)
  — `types.ts` (`SkillAnalysisHandler`/`SkillAnalysisContext`/`SkillAnalysisResult`, reusing the chat
  path's real `RetrievalScope` + the shared `Citation`/`CoverageInfo`), `registry.ts` (`register`/`get`
  keyed by `install_id`, **no import-time side effects** — precedent `tool-registry.ts`),
  `bank-statement.ts` (the `app:bank-statement` handler), `index.ts` (`registerBuiltinSkillAnalysisHandlers()`,
  the EXPLICIT registration Phase 3 calls once at app init). **NOT wired into chat** — `registerRagIpc.ts`/
  `router.ts`/`rag/index.ts` are untouched, so the relevance path is byte-identical (R5) trivially.
  `applies()` is conservative: a single in-scope doc (`buildScopeFilter`, mirroring
  `registerRagIpc.documentsInScope`) **and** an analysis-shaped keyword (EN+DE) — off-topic keeps
  relevance (§3.2); the refuse / not-fully-chunked routing gate is Phase 3. `run()` drives the run
  seams (`runBankExtraction` → `runCashflowSummary` + `runBalanceValidation`, + `runCategorization`
  only when category-shaped) for their `skill_runs` lifecycle + persistence + ids/counts audit, then
  computes the answer's FIGURES from the persisted rows via the PURE exported functions
  (`summarizeCashflow`/`reconcileBalances`/`categorizeRow`) — the run seams surface only counts.
  `runCsvExport` is never imported (export excluded by construction). The answer is deterministic,
  localized Markdown (precedent `analysis/listing-answer.ts`): count → unreconciled rows BEFORE the
  total → totals (or an honest "no single total" on mixed currency) → optional per-category breakdown →
  caveat. Citations are real `chunks` rows narrowed to the transactions' `sourcePage` (`[Sn]`, M2-safe —
  never the synthesised total). Coverage is `{ mode:'extract', chunksCovered=chunksTotal, chunksTotal,
  fullyChunked }` (`documentChunkCount` + the `documents.fully_chunked` column; NULL → false), gating
  the "whole document" wording (D48). New i18n: `skills.bankAnalysis.*` (EN + DE parity). 15 new tests
  in [`skills-analysis-bank.test.ts`](../apps/desktop/tests/integration/skills-analysis-bank.test.ts);
  suite **1807 green**, typecheck + build clean.

### Phase 3 — Router wiring + refuse-partial + i18n
- `registerRagIpc`: route tool-skill analysis turns to the handler; enforce the `fully_chunked`
  precondition with the **refuse** answer + re-index action (D45); stamp whole-document coverage.
- EN + DE strings for the refuse notice and any new copy; reuse existing `coverage.extract.*`.
- Integration tests: exhaustive path (coverage = whole), refuse path (not fully chunked → no model
  call, honest message), relevance path for non-analysis questions byte-unchanged, export still gated,
  single-slot contract preserved.

### Phase 4 — Generalise + docs
- Confirm `invoice` registers a handler on the same seam; `document-redaction` intentionally does not.
- Fold this plan into [`architecture.md`](architecture.md) "Skills — design record" (+ rag-design §14
  coverage cross-link), update [`known-limitations.md`](known-limitations.md) (the relevance-vs-whole
  story now has a third state: tool-skill exhaustive), update [`BUILD_STATE.md`](../BUILD_STATE.md),
  **delete this plan file.**

---

## 5. Risks / landmines to watch

- **R1 — context overflow.** A pathological statement with thousands of rows could make even the
  *structured* answer large. The synthesis must summarise (totals + flagged rows), not echo every row;
  `MAX_TRANSACTIONS` (10000) already caps extraction.
- **R2 — multi-doc scope.** `applies()` should require a well-defined doc set (the bank handler is
  single-statement). A scope of several statements either refuses or analyses each — decide in Phase 3;
  default to **single in-scope doc** for the first cut, refuse otherwise (honest, not silent).
- **R3 — auto-run latency.** Auto-running tools adds work before the first token; reuse the chat-slot
  acquisition + progress events so the UI shows activity (the coverage-extract branch is the model).
- **R4 — coverage drift.** If a doc is fully chunked but a later edit makes it stale, the precondition
  must read the *current* `tree_status`/chunk state at turn time, not a cached flag.
- **R5 — the relevance path must stay byte-identical** for every non-re-routed turn (no regression to
  existing RAG answers). `applies()` gating + the NULL-coverage fallback guarantee this.
