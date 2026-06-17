import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { DocumentChunkRead, SkillToolAudit, SkillToolContext } from '../../../shared/types'
import { getRegisteredTool, runSkillTool } from './tool-registry'
import type { ExtractTransactionsOutput } from './tools/bank-statement'

// The app-orchestrated run seam (docs/skills-s11-plan.md §6, Phase S11a). This is the exact
// function S11b's IPC/UI will call: it is invoked by the APP from a user action (DS4), never by the
// model parsing tool_calls. It builds the NARROW `SkillToolContext` (frozen scope + the only content
// reach, `readDocumentChunks`), runs `extract_transactions` THROUGH the S10 gate (`runSkillTool` —
// validate→run→validate), and on success persists the rows. No IPC/renderer in S11a.
//
// Two sinks, deliberately distinct:
//   - the GATE brackets the TOOL run on the ids/counts-only AUDIT sink (skill_run_started/done/failed);
//   - this SEAM owns the `skill_runs` TABLE row (the run-history lifecycle) + the content-class bank
//     data tables. The table never stores content: document_ids_json is ids, result_ref is the
//     bank_statements id, error is friendly/technical (skills-plan §8.2/§9.5).
// A persist failure ROLLBACKs so NO partial bank rows survive (no-partial-persist, §12.2).

const EXTRACT_TOOL_NAME = 'extract_transactions'

export interface BankExtractionArgs {
  /** The requesting skill's `install_id` ("<source>:<id>") — for the run row + ids/counts audit. */
  skillInstallId: string
  /** The conversation the run belongs to, if any (a doc-action run may not be a chat). */
  conversationId?: string | null
  /** The single selected document to extract from (becomes the frozen one-id scope). */
  documentId: string
}

export interface BankExtractionDeps {
  /** ids/counts-only audit sink (the app's recorder adapter; a capturing fn in tests). */
  audit: SkillToolAudit
  /** Cooperative cancellation (S11b wires the Cancel affordance to this). */
  signal?: AbortSignal
  /** Optional progress, merged into the polling status by the app. */
  onProgress?: (p: { done: number; total: number }) => void
  /** Clock seam for deterministic tests. */
  now?: () => string
}

export interface BankExtractionResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure, so the lifecycle is recorded). */
  runId: string
  /** The created `bank_statements.id` on success. */
  statementId?: string
  transactionCount?: number
  /** A friendly, content-free reason on failure. */
  error?: string
}

/**
 * Build the scope-bounded content read for the context (skills-plan §12 / S11a). It is the WHOLE of
 * a tool's content reach: a per-document chunk read confined to the `allowed` id set — an id outside
 * the frozen scope returns `[]`. NOT a general Db/SQL/FS handle (the closure is the only capability).
 */
function buildReadDocumentChunks(db: Db, allowed: ReadonlySet<string>): SkillToolContext['readDocumentChunks'] {
  const stmt = db.prepare(
    'SELECT text, page_number AS page, chunk_index AS idx FROM chunks WHERE document_id = ? ORDER BY chunk_index'
  )
  return (documentId: string): DocumentChunkRead[] => {
    if (!allowed.has(documentId)) return [] // scope-bounded: an out-of-scope id is refused
    const rows = stmt.all(documentId) as unknown as Array<{ text: string; page: number | null; idx: number }>
    return rows.map((r) => ({ text: r.text, page: r.page ?? null, index: r.idx }))
  }
}

function finishRun(
  db: Db,
  runId: string,
  status: 'done' | 'failed' | 'cancelled',
  completedAt: string,
  resultRef: string | null,
  error: string | null
): void {
  db.prepare(
    'UPDATE skill_runs SET status = ?, completed_at = ?, result_ref = ?, error = ? WHERE id = ?'
  ).run(status, completedAt, resultRef, error, runId)
}

/**
 * Run `extract_transactions` on one selected document through the gate and persist the result.
 * Returns ids/counts only — never the extracted content (which lives only in the bank data tables).
 */
export async function runBankExtraction(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps
): Promise<BankExtractionResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]

  // Record the run as started BEFORE the gate (committed; survives a later ROLLBACK of the bank rows).
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify(documentIds), now())

  const tool = getRegisteredTool(EXTRACT_TOOL_NAME)
  if (!tool) {
    // No run happened ⇒ no audit event (matches the gate's "pre-run refusals are not audited").
    const msg = 'This tool is not available.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, error: msg }
  }

  const signal = deps.signal ?? new AbortController().signal
  const ctx: SkillToolContext = {
    documentIds,
    readDocumentChunks: buildReadDocumentChunks(db, new Set(documentIds)),
    signal,
    onProgress: deps.onProgress,
    audit: deps.audit
  }

  const result = await runSkillTool(tool, {
    skillId: args.skillInstallId,
    input: { documentId: args.documentId },
    ctx
  })

  if (!result.ok) {
    finishRun(db, runId, signal.aborted ? 'cancelled' : 'failed', now(), null, result.error)
    return { ok: false, runId, error: result.error }
  }

  // Persist the schema-validated output atomically — a failed write leaves NO partial rows.
  const output = result.output as ExtractTransactionsOutput
  const statementId = randomUUID()
  const completedAt = now()
  try {
    db.exec('BEGIN')
    db.prepare(
      `INSERT INTO bank_statements (id, document_id, run_id, period_start, period_end, currency, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`
    ).run(statementId, args.documentId, runId, output.currency ?? null, completedAt)
    const insertTx = db.prepare(
      `INSERT INTO bank_transactions
        (id, statement_id, run_id, row_index, date, value_date, description, amount, currency, balance_after, source_page, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    output.transactions.forEach((t, i) => {
      insertTx.run(
        randomUUID(),
        statementId,
        runId,
        i,
        t.date,
        t.valueDate ?? null,
        t.description,
        t.amount,
        t.currency,
        t.balanceAfter ?? null,
        t.sourcePage ?? null,
        completedAt
      )
    })
    db.prepare(
      `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
    ).run(completedAt, statementId, runId)
    db.exec('COMMIT')
  } catch {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* keep the original failure */
    }
    // Technical reason to the local log only — never the renderer/audit (§22-M1).
    console.error('[skills] bank extraction failed to persist')
    const msg = 'This statement could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, error: msg }
  }

  return { ok: true, runId, statementId, transactionCount: output.transactions.length }
}
