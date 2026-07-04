// Bank-statement categorizer handler (DX-1 split, full-audit-2026-06-29 follow-up Phase 8).
// Relocated VERBATIM from `manager.ts`; `this.deps` became `ctx.deps`. The runtime is OPTIONAL
// here (a null runtime degrades to the deterministic rule pass). Behavior unchanged.

import { tMain } from '../../i18n'
import type {
  DocumentChunkRead,
  SkillToolAudit
} from '../../../../shared/types'
import type { ModelRuntime } from '../../runtime'
import { withDocumentLock } from '../../skills/doc-lock'
import {
  runBankExtraction,
  ensureBuiltinCategories,
  latestBankStatementId,
  isBankStatementStale
} from '../../skills/run'
import { categorizeTransactions } from '../../skills/categorizer'
import { skillInstallId } from '../../skills/registry'
import type { TransactionInput } from '../../skills/tools/bank-statement'
import { extractDocumentPreview } from '../../ingestion'
import type { DocTaskCtx, InternalTask } from '../context'

/**
 * The bank-statement LLM categorizer task (Phase 33; architecture.md §22). It lives in the doctask
 * lane PURELY for the chat↔task one-job-at-a-time exclusion (D26) — the `SkillRunController` and the
 * `ModelSlotArbiter` are separate lanes that wouldn't stop two `chatStream` calls hitting the one
 * llama-server at once. Steps: (1) locate the latest statement for the document and AUTO-EXTRACT it
 * first when none exists (fixes the (D) "categorize before extract" ordering failure); (2) run the
 * categorizer over the rows (`runtime` null ⇒ deterministic rule pass — model-OPTIONAL); (3) persist
 * `bank_transactions.category_id` ATOMICALLY (no partial annotations survive a failure). A category is
 * not a figure, so this never touches the verified total or the D56 gate — only the breakdown. The
 * source document id is the resultRef. Aborts propagate (a cancel lands in `cancelled`, nothing partial).
 */
export async function runCategorize(
  task: InternalTask,
  runtime: ModelRuntime | null,
  ctx: DocTaskCtx
): Promise<string> {
  const documentId = task.status.documentIds[0]
  // Serialize the WHOLE auto-re-extract + categorize-persist per document across lanes (audit PC-1):
  // the (1) re-extract DELETE+INSERT and the (3) `category_id` persist must be atomic w.r.t. a
  // concurrent run on the same statement (a button re-extract / a chat analysis re-extract that would
  // delete the statement mid-categorize → "vanished mid-read" / orphaned rows). The inner
  // `runBankExtraction` self-lock is re-entrant under this hold; unrelated documents stay concurrent.
  // The task signal rides along (SKA-24): a categorize cancelled while PARKED behind another lane
  // rejects with the AbortError the manager already maps to 'cancelled' (same class as line (1)'s throw).
  return withDocumentLock(documentId, async () => {
    const signal = task.controller.signal
    const db = ctx.deps.getDb()
    const nowIso = new Date().toISOString()

    // (1) The latest statement. Auto-extract first when the user clicked categorize before extract, OR
    // when the latest was produced by an outdated extractor (A9 — `isBankStatementStale`): categorizing
    // rows a since-fixed parser bug mis-signed / lost a payee on is wasted work, so re-extract (replacing
    // the stale statement) and categorize the corrected rows.
    let statementId = latestBankStatementId(db, documentId)
    if (!statementId || isBankStatementStale(db, statementId)) {
      const audit: SkillToolAudit = (type, meta) => ctx.deps.audit?.(type, type, meta)
      const ingestion = ctx.deps.getIngestionDeps()
      const storeDir = ctx.deps.getStoreDir()
      const readDocumentSegments = async (
        id: string,
        opts?: { layout?: boolean }
      ): Promise<DocumentChunkRead[]> => {
        const preview = await extractDocumentPreview(
          db,
          storeDir,
          id,
          { cipher: ingestion.cipher, ocrEngine: ctx.deps.getOcrEngine?.() ?? ingestion.ocrEngine },
          { layout: opts?.layout }
        )
        return preview.segments.map((s, index) => ({ text: s.text, page: s.pageNumber, index }))
      }
      const ext = await runBankExtraction(
        db,
        { skillInstallId: skillInstallId('app', 'bank-statement'), conversationId: null, documentId },
        { audit, signal, readDocumentSegments, layout: true, replaceExisting: true }
      )
      if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
      if (!ext.ok || !ext.statementId) throw new Error(tMain('main.task.documentNotReady'))
      statementId = ext.statementId
    }

    // (2) Load the rows (with ids, in stable order) and categorize them.
    const loaded = db
      .prepare(
        `SELECT id, date, description, amount, currency
         FROM bank_transactions WHERE statement_id = ? ORDER BY row_index`
      )
      .all(statementId) as Array<{ id: string; date: string; description: string; amount: number; currency: string }>
    const rows: TransactionInput[] = loaded.map((r) => ({
      date: r.date,
      description: r.description,
      amount: r.amount,
      currency: r.currency
    }))
    const { assignments, modelAssisted } = await categorizeTransactions(rows, {
      runtime,
      signal,
      onProgress: (done, total) => {
        task.status.progress.stepsDone = done
        task.status.progress.stepsTotal = total
      }
    })
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')

    // (3) Persist atomically — seed the categories (union of rule + LLM taxonomy), update each row, and
    // record whether the LLM was consulted (the authoritative model-assisted signal the read-back labels
    // the breakdown by — never re-derived from the category names). A failure ROLLBACKs so no partial
    // categorization survives (no-partial-persist).
    try {
      db.exec('BEGIN')
      const byName = ensureBuiltinCategories(db, nowIso)
      const upd = db.prepare('UPDATE bank_transactions SET category_id = ? WHERE id = ?')
      for (const a of assignments) {
        const tx = loaded[a.index]
        const catId = byName.get(a.category)
        if (tx && catId) upd.run(catId, tx.id)
      }
      db.prepare('UPDATE bank_statements SET categorized_by_model = ? WHERE id = ?').run(
        modelAssisted ? 1 : 0,
        statementId
      )
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* keep the original failure */
      }
      throw err
    }
    return documentId
  }, task.controller.signal)
}
