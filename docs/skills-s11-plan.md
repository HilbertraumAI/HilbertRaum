# Skills Phase S11 — Tool-enabled bank-statement skill (working-paper plan)

> **Status: OPEN working paper** (doc-lifecycle rule). S11 is the first Tier-2 *feature* wave: the
> real bank-statement tools running through the S10 gate, the run-history + bank data tables, and the
> app-orchestrated chat/UI that drives them. This file stays open until S11 closes (after S11c), then
> folds into the §-records at **S12** (per the §18 fold-map: the tool registry/tools + run
> orchestration → `architecture.md` "Skills — design record"; the tool ceiling + content-class data →
> `security-model.md`; this file is then deleted, the original kept in git history).
>
> It refines, never contradicts, `docs/skills-plan.md` §12 (typed tool interface + app-orchestrated
> DS4 flow), §13 (the 5 bank tools + future data concepts), §8.2 (the `skill_runs` DDL), §14 (threat
> model), §9.5 (export excludes `skill_runs`), and §18 (the S11 row). Where this file is more specific
> than §13 (e.g. the exact data-table columns), this file is the build reference for S11.

## 0. What S10 left for S11 (the starting line)

S10 shipped the **gate**, not a feature:
[`tool-registry.ts`](../apps/desktop/src/main/services/skills/tool-registry.ts) holds the static
app-owned `REGISTRY`, `resolveEffectiveTools(declared ∩ registry ∩ userGrant)`,
`toolRequiresConfirmation`, the hand-rolled `validateJsonSchema` subset, and `runSkillTool` — the
**app-orchestrated** (DS4, never model `tool_calls`) gate:

```
abort? → validate input (refuse before run) → confirm-gate (write/export) →
run on a FROZEN-scope SkillToolContext → validate output (wrong shape fails the run) →
ids/counts-only audit (skill_run_started → done|failed)
```

It ships exactly one harmless reference tool (`count_selected_documents`). The shared tool types
(`JsonSchema`, `ToolPermission`, `ToolResult`, `SkillToolAudit`, `SkillToolContext`, `SkillTool`)
live in [`shared/types.ts`](../apps/desktop/src/shared/types.ts). **No** bank tools, **no**
`skill_runs` table, **no** bank data tables, **no** content-read accessor, **no** IPC/UI exist yet.

## 1. Ratified scope cut (AskUserQuestion, owner, 2026-06-17)

| # | Decision | Ratified |
|---|---|---|
| 1 | First slice (S11a) ships **`extract_transactions` only**; the other 4 tools are S11c | ✅ |
| 2 | **`export_transactions_csv` deferred to S11c** — the only write/export + FS-write surface; ship it once the confirm modal exists (S11b) | ✅ |
| 3 | Content-read API = **page-addressable chunks** (`{text, page, index}[]`), not a full-text blob — gives `sourcePage` provenance and bounds memory | ✅ |
| 4 | A run is **purely user-initiated from the UI** in v1 — no model `tool_calls`, no deterministic auto-run | ✅ |

## 2. Sub-phase breakdown (each = its own commit + full per-phase ritual)

- **S11a — tools behind the gate, no UI** *(this task)*: the content-read accessor on
  `SkillToolContext`; the `skill_runs` table; the bank data tables `extract_transactions` needs;
  `extract_transactions` in the `REGISTRY`; a thin main-side **orchestration seam**
  (`services/skills/run.ts`: build narrow ctx → `runSkillTool` → persist) proven by tests. **No IPC,
  no renderer.** SKILL.md **stays `kind: instruction`** (no flip).
- **S11b — the app-orchestrated run trigger + UI** *(SHIPPED 2026-06-17)*: a user action in the chat
  surface starts a run (DS4 trigger, decision #4); the inline calm **"Running: `<tool>` on `<N>`
  documents… (Cancel)"** busy row (the doc-task busy-row precedent); the **write/export confirm modal**
  (the model-download / lock-now precedent), wired so S11c's export tool can use it. IPC
  (`requireUnlocked`, logs nothing — the question/scope is content) + preload + renderer + EN/DE.
  - **As built:** four generic `skills:*` channels (`listRunnableTools` / `startSkillRun` /
    `getSkillRun` / `cancelSkillRun`) over a generic `run-controller.ts` (single active run, polling,
    cancel) + a `tool-runs.ts` dispatch (the one place that maps a tool name → the `run.ts` seam, §13).
    Renderer: `lib/skillruns.ts` polling store + `chat/SkillRunBar.tsx` (offer → busy → result + the
    `ConfirmDialog` path). The trigger keys off `reservesTools` (instruction-kind discards declared
    names, S9/SL-1); the confirm modal is exercised by a synthetic write tool (controller + renderer
    tests). **Carry-forward:** the running-model Playwright eyeball of the busy row + confirm modal is
    deferred (needs a seeded doc + run; the S6-style walk forwarding).
- **S11c — the remaining tools + the flip**: `validate_statement_balances`,
  `categorize_transactions`, `summarize_cashflow`, `export_transactions_csv` (confirm-gated
  `export-file`); the additive categories/rules/corrections/reconciliation tables those need; **then
  flip `app-skills/bank-statement/SKILL.md` to `kind: 'tool'`** and swap its body to the §6.6
  reconcile/validate body; update the S5 detail-drawer note from "tools arrive with Tier-2" to the
  real tool list + the **"✓ Use approved local tools"** permission line.

### Why the flip is S11c, not S11a (the SL-1 path)
The S2 parser empties `allowedTools` to `[]` for a `kind: instruction` skill (a frozen contract
test); only `kind: 'tool'` keeps the declared list, which is what makes `resolveEffectiveTools`
return a non-empty set for the skill. So the flip is what makes `allowedTools` **effective**. We
hold it until S11c because (a) S11a has no UI to run a tool from and only 1 of 5 tools wired, and (b)
flipping early would make the drawer claim full tool capability the build can't yet deliver — exactly
the §22-D1 over-promise the S9 stub was written to avoid. Until the flip, the drawer note keeps
triggering off `reservesTools` (the S9 mechanism), honestly showing "tools arrive with Tier-2."

## 3. Data model

### 3.1 `skill_runs` — generic run history (§8.2, verbatim, ids/refs only)
Created in **S11a**. Content-class metadata is forbidden: `document_ids_json` is ids only,
`result_ref` is a `bank_statements.id`, `error` is a friendly/technical reason — never document or
chat text.

```sql
CREATE TABLE IF NOT EXISTS skill_runs (
  id                TEXT PRIMARY KEY,
  skill_install_id  TEXT NOT NULL,          -- references skills.install_id ("<source>:<id>")
  conversation_id   TEXT,                   -- nullable: a doc-action run may not be a chat
  document_ids_json TEXT,                   -- ids only, never content
  status            TEXT NOT NULL,          -- 'started' | 'done' | 'failed' | 'cancelled'
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  result_ref        TEXT,                   -- e.g. a bank_statements.id; NEVER inline content
  error             TEXT                    -- friendly/technical reason; NEVER document/chat text
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_install_id);
```

### 3.2 Bank data tables — CONTENT-CLASS
The extracted figures **are** user content. They live only in the **encrypted workspace DB**
(so a workspace backup carries them — correct), are **never logged/audited** (audit stays
ids/counts), and are **never** in the skill `.skill.zip` export or the conversation export (§9.5).
This is distinct from the *non-secret* skill packages (DS20): a transaction row is as sensitive as a
document, the SKILL.md is not.

**S11a creates only the two `extract_transactions` needs** (the rest are additive at S11c — the
`tree_nodes`-per-feature precedent; §13 "the generic plan must not overbuild bank-statement
specifics"):

```sql
CREATE TABLE IF NOT EXISTS bank_statements (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,              -- the source document (id only)
  run_id        TEXT,                       -- the skill_runs.id that produced this extraction
  period_start  TEXT,                       -- as printed, nullable
  period_end    TEXT,
  currency      TEXT,                       -- statement currency, nullable
  created_at    TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_bank_statements_document ON bank_statements(document_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id             TEXT PRIMARY KEY,
  statement_id   TEXT NOT NULL,             -- references bank_statements.id
  run_id         TEXT,
  row_index      INTEGER NOT NULL,          -- stable order within the statement
  date           TEXT NOT NULL,             -- content: booking date as printed (ISO)
  value_date     TEXT,                      -- content
  description    TEXT NOT NULL,             -- content
  amount         REAL NOT NULL,             -- content: signed
  currency       TEXT NOT NULL,
  balance_after  REAL,                      -- content, nullable
  source_page    INTEGER,                   -- provenance (1-based) for quoting
  created_at     TEXT NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES bank_statements(id)
);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_statement ON bank_transactions(statement_id);
```

**Full future DDL (decided now; created additively at S11c)** — categorization + reconciliation +
user corrections, from §13's "future data concepts":

```sql
-- categorize_transactions / summarize_cashflow (S11c):
CREATE TABLE IF NOT EXISTS bank_categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_category_rules (
  id TEXT PRIMARY KEY, category_id TEXT NOT NULL, match_kind TEXT NOT NULL, -- 'description-substring' | 'amount-sign'
  pattern TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (category_id) REFERENCES bank_categories(id)
);
-- a transaction's assigned category (nullable assignment; corrections override the rule result):
ALTER TABLE bank_transactions ADD COLUMN category_id TEXT;          -- ensureColumn at S11c
ALTER TABLE bank_transactions ADD COLUMN reconciled INTEGER;        -- validate_statement_balances result, nullable
ALTER TABLE bank_transactions ADD COLUMN confidence REAL;           -- extraction/categorization confidence, nullable
CREATE TABLE IF NOT EXISTS bank_corrections (                       -- user edits to an extracted/categorized row
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  created_at TEXT NOT NULL, FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id)
);
```

## 4. The narrow content-read accessor (`SkillToolContext`)

S10 deliberately exposes **no** `Db`/SQL/FS/network handle. S11 adds the *only* content reach a tool
gets — a **page-addressable, scope-bounded read**, never a general handle:

```ts
// shared/types.ts (additive)
export interface DocumentChunkRead {
  text: string            // chunk text (content — never logged/audited)
  page: number | null     // page_number provenance → fills transaction.sourcePage
  index: number           // chunk_index (stable order)
}
// on SkillToolContext (additive):
readDocumentChunks(documentId: string): DocumentChunkRead[]
```

- **Sync** (node:sqlite is synchronous; matches the existing sync DB reads).
- **Scope-bounded:** an id **not** in the frozen `documentIds` allowlist is refused (returns `[]`).
  This is the whole of a tool's content reach — no raw handle is ever added; confused-deputy
  containment stays structural (§14), not policy.
- Built **main-side** (the orchestration seam) as a closure over a narrow read
  (`SELECT text, page_number, chunk_index FROM chunks WHERE document_id = ? ORDER BY chunk_index`),
  itself gated by the allowlist. `shared/types.ts` stays shared-safe (no `main/` import; the method
  is supplied by the caller). The gate's existing re-freeze of `documentIds` is unchanged.

## 5. `extract_transactions` (S11a)

- `permissions: ['read-selected-docs']` (read-only, no confirm).
- `inputSchema`: `{ documentId: string(minLength 1) }`, `additionalProperties: false`, required.
- `outputSchema`: `{ transactions: array<transaction-row> }`, the row expressed in the `JsonSchema`
  subset and matching the committed
  [`transaction.schema.json`](../app-skills/bank-statement/schemas/transaction.schema.json)
  (date/valueDate/description/amount/currency/balanceAfter/sourcePage), with a `maxItems` cap.
- `run`: `ctx.readDocumentChunks(documentId)` (refused if out of scope) → a **deterministic,
  offline** line parser (date + signed amount + ISO-4217 currency; `sourcePage` from the chunk's
  `page`) → emits **only** rows it can fully and confidently populate; ambiguous rows are **dropped,
  never invented** (the §22-D1 honesty posture — the deterministic extractor is a known limitation,
  not an ML claim; quality improves later). No model call. **Persists nothing itself** — the gate
  stays content-free; persistence is the orchestration seam's job (§6).

## 6. App-orchestrated run trigger (DS4)

A run is **initiated by the app from a user action**, never by the model. The seam:

```ts
// services/skills/run.ts (S11a) — the exact function S11b's IPC/UI calls.
runBankExtraction(db, { skillInstallId, conversationId?, documentId }, { audit, signal?, onProgress? })
  → { ok, runId, statementId?, transactionCount?, error? }
```

1. insert `skill_runs` (`status='started'`, `document_ids_json=[documentId]`);
2. build the narrow `SkillToolContext` (frozen `documentIds=[documentId]`, the `readDocumentChunks`
   closure, the `AbortSignal`, `onProgress`, the ids/counts `audit`);
3. `runSkillTool(extract_transactions, …)`;
4. **success** → in one `BEGIN…COMMIT` (ROLLBACK on throw — the `node-vectors.ts`/`tree-build.ts`
   precedent) persist one `bank_statements` + the `bank_transactions` rows, then set `skill_runs`
   `done` + `result_ref = statementId`; **failure/abort** → set `failed`/`cancelled` with a friendly
   content-free `error`, persist **no** partial rows (no-partial-persist, §12.2).

In **v1 the trigger is purely user-initiated** (decision #4): a transcript affordance / the user
accepting the skill on a turn that maps to the tool. The model only *explains* the structured,
schema-validated result. **No** `tool_calls` parsing; native function-calling stays a future option
behind the same gate (§12.2).

## 7. Audit / privacy invariants (sentinel-grep tested)

- Audit is **ids/counts only**: `skill_run_started/done/failed` with `{skillId, toolName,
  documentCount}`. The `SkillToolAudit` sink structurally cannot carry a free-text message.
- The S11a test pushes a **sentinel** secret as a transaction description through a **successful**
  run and proves it never appears in the audit payloads, the local log, or the `skill_runs` row
  (`document_ids_json`/`result_ref`/`error`). It *does* land in `bank_transactions` (content-class,
  encrypted DB) — that is correct; the assertion targets audit/log/run-metadata only.
- Export: `skill_runs` + bank data tables are excluded from the skill `.skill.zip` and the
  conversation export (§9.5); guard test in S11a.

## 8. Out of scope for S11 (still later waves)
Native model tool-calling (DS4 keeps it a future option); auto-fire of a tool from a trigger (S13,
gated on the eval harness); cross-statement analytics; multi-document batch extraction (the v1 tool
takes one `documentId`).
