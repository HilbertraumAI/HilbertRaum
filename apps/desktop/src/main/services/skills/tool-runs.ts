import type { Db } from '../db'
import type { AuditRecorder } from '../audit'
import type { AuditEventType, DocumentChunkRead, RunnableTool, SkillToolAudit } from '../../../shared/types'
import type { SkillRecord } from './registry'
import { resolveScope } from '../collections'
import { buildScopeFilter } from '../retrieval-scope'
import { getRegisteredTool, resolveEffectiveTools, toolRequiresConfirmation } from './tool-registry'
import { skillNeedsNewerApp } from '../../../shared/skill-manifest'
import {
  runBankExtraction,
  runBalanceValidation,
  runCashflowSummary,
  runCategorization,
  runCsvExport,
  runDocumentRedaction
} from './run'
import { runInvoiceCsvExport, runInvoiceExtraction, runInvoiceTotalsValidation } from './invoice-run'
import type { ToolRunner, ToolRunOutcome } from './run-controller'
import type { DocTaskManager } from '../doctasks/manager'

// The app-orchestrated tool-run DISPATCH (skills plan §6/§12.2, Phase S11b). This is the ONE place
// that maps a registry tool name to its persistence seam (`run.ts`) and so is allowed to know bank
// specifics — exactly as `tools/bank-statement.ts` is (§13). The generic infra (the run controller,
// registerSkillsIpc, the renderer) stays bank-free and talks only in `RunnableTool`/handles.
//
// S11c wires all five bank tools: extract/validate/categorize/summarize (read-only, no confirm) +
// export_transactions_csv (confirm-gated `export-file` — the SkillRunBar modal already gates it; the
// MAIN-side save is supplied here as an opaque `saveTextFile`). The INVOICE domain adds three more of
// the same shape (extract/validate read-only + export_invoice_csv confirm-gated) behind the
// `invoice-run.ts` seam. The channel/controller/renderer are unchanged — the per-domain specifics
// stay in this dispatch + the `run.ts`/`invoice-run.ts` seams (§13).

/** The tools whose run seam is wired (each has a `buildToolRunner` case below). */
const WIRED_TOOL_NAMES: readonly string[] = [
  'extract_transactions',
  'validate_statement_balances',
  'categorize_transactions',
  'summarize_cashflow',
  'export_transactions_csv',
  // Invoice — the SECOND Tier-2 domain (same gate, same dispatch shape; the invoice-run.ts seam).
  'extract_invoice',
  'validate_invoice_totals',
  'export_invoice_csv',
  // Redaction — the read-transform-export shape (confirm-gated `export-file`; no data table).
  'redact_document'
]

/** Canonical English audit messages for the ids/counts-only run events (the recorder needs one). */
const SKILL_RUN_MESSAGE: Partial<Record<AuditEventType, string>> = {
  skill_run_started: 'Skill tool run started',
  skill_run_done: 'Skill tool run completed',
  skill_run_failed: 'Skill tool run failed'
}

/**
 * Bridge the app's `AuditRecorder` (type, message, meta) down to the narrow ids/counts-only
 * `SkillToolAudit` (type, meta) the gate calls — the message is a fixed canonical string, so a tool
 * can still never smuggle free text into the log (§22-M1).
 */
export function toSkillToolAudit(audit?: AuditRecorder): SkillToolAudit {
  return (type, meta) => audit?.(type, SKILL_RUN_MESSAGE[type] ?? type, meta)
}

/**
 * The indexed documents in a conversation's scope (ids only), resolved MAIN-side from the
 * conversationId (§22-C4 — the renderer never assembles document ids). Deterministically ordered so
 * the v1 single-document tools pick a stable target. Empty-tolerant (unknown/locked conversation).
 */
export function resolveInScopeDocumentIds(db: Db, conversationId: string): string[] {
  if (!conversationId) return []
  let scope
  try {
    scope = resolveScope(db, conversationId)
  } catch {
    return []
  }
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const params = filter ? filter.params : []
  const rows = db
    .prepare(
      `SELECT d.id AS id FROM documents d
       WHERE d.status = 'indexed'${where} ORDER BY d.created_at, d.id`
    )
    .all(...params) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * The wired tool names a skill may run (skills plan §12.2, S11c). The S11c flip makes the bank skill
 * `kind:'tool'`, so the S2 parser KEEPS its declared `allowedTools` (an instruction skill's stays []
 * — SL-1). The effective set is `declared ∩ registry ∩ grant`; v1 has no per-tool grant UI, so
 * enabling a `kind:'tool'` skill grants its declared tools (grant = declared). We then keep only the
 * tools actually wired to a `run.ts` seam below. An instruction skill (allowedTools []) gets none.
 *
 * §6.5/M1 gate at the use-site: a skill that now needs a newer app runs NO tools, even if its
 * `enabled` flag is stale (edited on disk after it was enabled). `appVersion` absent / '' ⇒ compatible.
 */
export function runnableToolNames(skill: SkillRecord, appVersion = ''): string[] {
  if (skillNeedsNewerApp(skill.manifest.compatibility.minAppVersion, appVersion)) return []
  const effective = resolveEffectiveTools(skill.manifest.allowedTools, skill.manifest.allowedTools)
  return effective.filter((n) => WIRED_TOOL_NAMES.includes(n))
}

/** The `RunnableTool` descriptors for a skill (name + whether the renderer must confirm first). */
export function runnableToolsForSkill(skill: SkillRecord, appVersion = ''): RunnableTool[] {
  return runnableToolNames(skill, appVersion).map((name) => ({
    name,
    requiresConfirmation: toolRequiresConfirmation(getRegisteredTool(name)!)
  }))
}

/** Whether a wired tool needs a confirm modal before it runs (registry-driven; the gate enforces). */
export function toolRunNeedsConfirmation(toolName: string): boolean {
  const tool = getRegisteredTool(toolName)
  return tool ? toolRequiresConfirmation(tool) : false
}

export interface BuildRunnerArgs {
  skillInstallId: string
  conversationId: string
  /** The single target document (the v1 tools are single-document; plan §8). */
  documentId: string
  confirmed?: boolean
}

/** MAIN-side capabilities the dispatch needs but cannot import (kept out so this stays testable). */
export interface ToolRunDeps {
  /**
   * Save CSV text to a user-chosen path (save dialog + write). Returns true once written, false if
   * the user cancelled. The path + content are NEVER logged/audited — `export_transactions_csv`'s
   * FS-write boundary (skills-plan §9.5/§22-M1). The IPC layer supplies it; tests inject a stub.
   */
  saveTextFile?: (defaultFileName: string, content: string) => Promise<boolean>
  /**
   * Re-extract a document's ordered, non-overlapping, newline-preserving parser SEGMENTS (the IPC
   * supplies `extractDocumentPreview`). This is the FAITHFUL content reach for the extract/redaction
   * tools — the stored `chunks` table collapses newlines and overlaps ~80 tokens, which breaks the
   * line-oriented extractors and the redaction copy (`run.ts` resolveDocumentReader). Tests may omit
   * it to exercise the legacy chunk-table reader against seeded chunks.
   */
  readDocumentSegments?: (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
  /**
   * The document-task manager (Phase 33). When present, `categorize_transactions` runs in the DOCTASK
   * lane — the only lane with the chat↔task one-job-at-a-time exclusion (D26), so the LLM categorizer's
   * `chatStream` can never race a chat answer on the one llama-server. The skill-run shell just mirrors
   * the doctask's progress/cancel into the run bar. Absent (tests/headless) ⇒ the deterministic seam.
   */
  docTasks?: DocTaskManager
}

/**
 * Run `categorize_transactions` by enqueuing a `'categorize'` doctask and MIRRORING its lifecycle into
 * the skill-run shell (Phase 33). The model call happens INSIDE the doctask (D26-safe); this only polls
 * its status, forwards Cancel, and maps the terminal state to a content-free outcome. The categorized
 * row count rides in the doctask's progress total.
 */
async function runCategorizeViaDocTask(
  docTasks: DocTaskManager,
  documentId: string,
  signal: AbortSignal,
  onProgress: (p: { done: number; total: number }) => void
): Promise<ToolRunOutcome> {
  let jobId: string
  try {
    jobId = docTasks.startDocTask({ kind: 'categorize', documentIds: [documentId] }).jobId
  } catch (e) {
    // A friendly guard (chat streaming / document not ready) — surface it as a failed run.
    return { ok: false, error: e instanceof Error ? e.message : undefined }
  }
  const onAbort = (): void => docTasks.cancelDocTask(jobId)
  if (signal.aborted) docTasks.cancelDocTask(jobId)
  else signal.addEventListener('abort', onAbort)
  try {
    for (;;) {
      const status = docTasks.getDocTask(jobId)
      onProgress({ done: status.progress.stepsDone, total: status.progress.stepsTotal })
      if (status.state === 'done') return { ok: true, transactionCount: status.progress.stepsTotal }
      if (status.state === 'cancelled') return { ok: false, cancelled: true }
      if (status.state === 'failed') return { ok: false, error: status.error ?? undefined }
      await new Promise((r) => setTimeout(r, 60))
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Build the `ToolRunner` for a wired tool (or `null` if the tool is not wired). The runner closes
 * over the right `run.ts` seam + the ids/counts-only audit and resolves to a content-free outcome.
 * The controller never sees content — persistence + the extracted/derived rows stay in the seam.
 */
export function buildToolRunner(
  db: Db,
  toolName: string,
  args: BuildRunnerArgs,
  audit: SkillToolAudit,
  deps: ToolRunDeps = {}
): ToolRunner | null {
  const seamArgs = {
    skillInstallId: args.skillInstallId,
    conversationId: args.conversationId,
    documentId: args.documentId
  }
  switch (toolName) {
    case 'extract_transactions':
      return async ({ signal, onProgress }) => {
        const res = await runBankExtraction(db, seamArgs, {
          audit,
          signal,
          onProgress,
          readDocumentSegments: deps.readDocumentSegments,
          // Geometry-aware layout reconstruction for the columnar statement (plan §3.1, D58 — bank only).
          layout: true
        })
        // Auto-offer (Phase 33, Q2): once a statement is extracted, kick off categorization in the
        // background doctask lane (D26-safe, model-optional). Best-effort — a refused start (chat
        // streaming) or no doctask lane just means the user categorizes manually later.
        if (res.ok && deps.docTasks) {
          try {
            deps.docTasks.startDocTask({ kind: 'categorize', documentIds: [args.documentId] })
          } catch {
            /* best-effort auto-offer */
          }
        }
        return {
          ok: res.ok,
          transactionCount: res.transactionCount,
          cancelled: res.cancelled,
          errorCode: res.errorCode,
          error: res.error
        }
      }
    case 'validate_statement_balances':
      return async ({ signal, onProgress }) => {
        const res = await runBalanceValidation(db, seamArgs, { audit, signal, onProgress })
        return {
          ok: res.ok,
          transactionCount: res.count,
          resultKind: res.resultKind,
          cancelled: res.cancelled,
          errorCode: res.errorCode,
          error: res.error
        }
      }
    case 'categorize_transactions':
      // The LLM categorizer runs in the doctask lane (D26 exclusion) when available; the skill-run
      // shell just mirrors its status. Without a doctask lane (tests/headless) fall back to the
      // deterministic seam directly.
      if (deps.docTasks) {
        const docTasks = deps.docTasks
        return ({ signal, onProgress }) => runCategorizeViaDocTask(docTasks, args.documentId, signal, onProgress)
      }
      return async ({ signal, onProgress }) => {
        const res = await runCategorization(db, seamArgs, { audit, signal, onProgress })
        return { ok: res.ok, transactionCount: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'summarize_cashflow':
      return async ({ signal, onProgress }) => {
        const res = await runCashflowSummary(db, seamArgs, { audit, signal, onProgress })
        return { ok: res.ok, transactionCount: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'export_transactions_csv':
      if (!deps.saveTextFile) return null // cannot export without the MAIN-side save capability
      return async ({ signal, onProgress }) => {
        const res = await runCsvExport(db, seamArgs, {
          audit,
          signal,
          onProgress,
          confirmed: args.confirmed,
          saveTextFile: deps.saveTextFile!
        })
        return { ok: res.ok, transactionCount: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'extract_invoice':
      return async ({ signal, onProgress }) => {
        const res = await runInvoiceExtraction(db, seamArgs, {
          audit,
          signal,
          onProgress,
          readDocumentSegments: deps.readDocumentSegments
        })
        return {
          ok: res.ok,
          transactionCount: res.lineItemCount,
          cancelled: res.cancelled,
          errorCode: res.errorCode,
          error: res.error
        }
      }
    case 'validate_invoice_totals':
      return async ({ signal, onProgress }) => {
        const res = await runInvoiceTotalsValidation(db, seamArgs, { audit, signal, onProgress })
        return {
          ok: res.ok,
          transactionCount: res.count,
          resultKind: res.resultKind,
          cancelled: res.cancelled,
          errorCode: res.errorCode,
          error: res.error
        }
      }
    case 'export_invoice_csv':
      if (!deps.saveTextFile) return null // cannot export without the MAIN-side save capability
      return async ({ signal, onProgress }) => {
        const res = await runInvoiceCsvExport(db, seamArgs, {
          audit,
          signal,
          onProgress,
          confirmed: args.confirmed,
          saveTextFile: deps.saveTextFile!
        })
        return { ok: res.ok, transactionCount: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'redact_document':
      if (!deps.saveTextFile) return null // cannot save the redacted copy without the MAIN-side capability
      return async ({ signal, onProgress }) => {
        const res = await runDocumentRedaction(db, seamArgs, {
          audit,
          signal,
          onProgress,
          confirmed: args.confirmed,
          saveTextFile: deps.saveTextFile!,
          readDocumentSegments: deps.readDocumentSegments
        })
        return {
          ok: res.ok,
          transactionCount: res.redactionCount,
          resultKind: res.resultKind,
          cancelled: res.cancelled,
          errorCode: res.errorCode,
          error: res.error
        }
      }
    default:
      return null
  }
}
