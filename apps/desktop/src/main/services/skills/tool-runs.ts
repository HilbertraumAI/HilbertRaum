import type { Db } from '../db'
import type { AuditRecorder } from '../audit'
import type { AuditEventType, DocumentChunkRead, RunnableTool, SkillToolAudit } from '../../../shared/types'
import type { SkillRecord } from './registry'
import { resolveScope } from '../collections'
import { documentsInScope } from './scope-documents'
import { getRegisteredTool, resolveWiredTools, toolRequiresConfirmation } from './tool-registry'
import { skillNeedsNewerApp } from '../../../shared/skill-manifest'
import { getToolDescriptor, type SkillToolSaveDialog } from '../../../shared/skill-tools'
import {
  runBankExtraction,
  runBalanceValidation,
  runCashflowSummary,
  runCategorization,
  runCsvExport,
  runDocumentRedaction
} from './run'
import {
  runInvoiceCsvExport,
  runInvoiceExtraction,
  runInvoiceFileExport,
  runInvoiceTotalsValidation
} from './invoice-run'
import type { ToolRunner, ToolRunOutcome } from './run-controller'
import type { DocTaskManager } from '../doctasks/manager'
import type { ModelRuntime } from '../runtime'

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

// `WIRED_TOOL_NAMES` is now DERIVED from the self-describing tool registry (`shared/skill-tools.ts`,
// audit §6.2) — one descriptor per wired tool is the single source, so a 9th tool no longer means
// editing a hardcoded list here, the runner switch, the renderer maps and the dialog metadata
// separately. Each name below still has a `buildToolRunner` case; the descriptor guard at the top of
// `buildToolRunner` keeps the wired set and the switch in lockstep (a parity test pins them).

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
  // The RUN path takes `requireChunks: false`: a button run re-extracts FAITHFULLY from the stored copy,
  // so an `indexed` document is runnable even before it is chunked (X-1). The shared helper's
  // deterministic `ORDER BY created_at, id` is what makes `[0]` the stable default run target (U-1/U-2).
  return documentsInScope(db, scope, { requireChunks: false }).map((d) => d.id)
}

/**
 * SEC-1 trust gate (backend-audit 2026-06-27, Phase 6): whether a skill is trusted to RUN the wired
 * Tier-2 tools (bank/invoice extraction, redaction, CSV export). ONLY built-in app skills
 * (`source === 'app'`, which the registry assigns from the app-skills/ folder — a self-declared trust
 * in frontmatter is already ignored) may. A user-imported `kind:'tool'` skill may still DECLARE
 * `allowedTools` (the S2 parser keeps them, and the import warning surfaces "reserves tools" — kept
 * for a future per-tool grant UI) but it runs NONE of them until that grant UI exists.
 *
 * Why a named predicate, not an inline `=== 'app'`: the audit found the run/runnable surface gated on
 * enabled/compatibility/confirm but NEVER on source, and `resolveEffectiveTools(declared, declared)`
 * collapsed the "user grant" to "whatever the package declared" — so the trust decision was
 * incidental. The blast radius is structurally bounded (the tool context holds no FS/DB/network
 * handle, scope is a single frozen document, writes/exports are confirm-gated to a user-chosen path),
 * so this is not closing an escape — it makes the "trusted product content only" posture DELIBERATE
 * and self-documenting. See security-model.md "Skill-import defences" and architecture.md §7/§23.
 */
export function skillCanRunTools(skill: SkillRecord): boolean {
  return skill.source === 'app'
}

/**
 * The wired tool names a skill may run (skills plan §12.2, S11c). The S11c flip makes the bank skill
 * `kind:'tool'`, so the S2 parser KEEPS its declared `allowedTools` (an instruction skill's stays []
 * — SL-1). The effective set is `declared ∩ registry ∩ wired` (`resolveWiredTools`, audit §6.4-low):
 * a declared name the app never registered/wired is dropped, so an APP `kind:'tool'` skill runs
 * exactly the wired tools it declared. An instruction skill (allowedTools []) gets none. The
 * vestigial per-tool `userGrant` leg is gone (A2 — no grant UI ever shipped; it fed the declaration
 * into itself), so trust is decided by `skillCanRunTools` (source), not an incidental grant no-op.
 *
 * SEC-1 trust gate: a non-app skill runs NO tools regardless of what it declared (`skillCanRunTools`).
 * This is THE choke point — both `listRunnableTools` and the run bar source their tool set here, so a
 * user `kind:'tool'` skill never offers a runnable tool.
 *
 * §6.5/M1 gate at the use-site: a skill that now needs a newer app runs NO tools, even if its
 * `enabled` flag is stale (edited on disk after it was enabled). `appVersion` absent / '' ⇒ compatible.
 */
export function runnableToolNames(skill: SkillRecord, appVersion = ''): string[] {
  if (!skillCanRunTools(skill)) return []
  if (skillNeedsNewerApp(skill.manifest.compatibility.minAppVersion, appVersion)) return []
  return resolveWiredTools(skill.manifest.allowedTools)
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

/**
 * Per-export save-dialog metadata (U5 / audit §6.2): title / filter label / extension(s), carrying
 * i18n KEYS (the IPC owns `tMain`). A2 folds this into the self-describing tool registry — each
 * export tool NAMES its own dialog in `shared/skill-tools.ts` (`descriptor.dialog`), and the dispatch
 * below reads it from there. The type is the registry's `SkillToolSaveDialog`; the alias keeps the
 * existing `SaveFileDialogMeta` name for the IPC layer. `SAVE_DIALOG_CSV` is the legacy default a
 * caller with no metadata falls back to — now derived from the CSV export descriptor, not a hand copy.
 * This killed the one-CSV-dialog-for-every-export drift (redaction's "Save redacted copy" used to get
 * an "Export transactions" title with a `.csv` filter fighting `redacted.txt` on Windows).
 */
export type SaveFileDialogMeta = SkillToolSaveDialog

/** The CSV export dialog — the default when a caller passes none. Derived from the registry (§6.2). */
export const SAVE_DIALOG_CSV: SaveFileDialogMeta = getToolDescriptor('export_transactions_csv')!.dialog!

/** MAIN-side capabilities the dispatch needs but cannot import (kept out so this stays testable). */
export interface ToolRunDeps {
  /**
   * Save text to a user-chosen path (save dialog + write). Returns true once written, false if the
   * user cancelled. The path + content are NEVER logged/audited — the skill exports' FS-write boundary
   * (skills-plan §9.5/§22-M1). The IPC layer supplies it; tests inject a stub. The optional `dialog`
   * (U5 / §6.2) carries the per-export title/filter/extension; omitted ⇒ the CSV default.
   */
  saveTextFile?: (defaultFileName: string, content: string, dialog?: SaveFileDialogMeta) => Promise<boolean>
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
  /**
   * The active chat runtime for the redaction LLM LOCATE pass (Phase 7, D73), or null when none runs.
   * Only `redact_document` uses it; a null runtime degrades the redaction to its deterministic floor
   * with an honest note. The IPC injects `ctx.runtime.active()`; tests omit it to exercise the floor.
   */
  runtime?: ModelRuntime | null
}

/**
 * Run `categorize_transactions` by enqueuing a `'categorize'` doctask and MIRRORING its lifecycle into
 * the skill-run shell (Phase 33). The model call happens INSIDE the doctask (D26-safe); this only polls
 * its status, forwards Cancel, and maps the terminal state to a content-free outcome. The categorized
 * row count rides in the doctask's progress total.
 *
 * Decision (Phase 31–33 follow-up): kept as a 60 ms poll rather than adding an awaitable
 * completion-promise + progress-callback channel to `DocTaskManager`. The full value of such a channel
 * (no copied poll loop) needs BOTH a terminal-state promise AND a per-tick progress callback — a
 * completion-only promise wouldn't remove this loop because progress still has to be mirrored. Wiring
 * both means touching the delicate lifecycle/abort paths (the three terminal transitions, the
 * queued-cancel branch, the arbiter-park unwind) for the ONE current consumer. Not worth that risk yet;
 * revisit when a SECOND doctask-backed skill-run button arrives and would copy this loop.
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
      if (status.state === 'done') return { ok: true, count: status.progress.stepsTotal }
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
 *
 * Wired-ness is DERIVED from the self-describing registry (`getToolDescriptor`, audit §6.2): a tool
 * with no descriptor (the `count_selected_documents` canary, X-2, or an unknown name) yields `null`
 * before the switch — the switch's per-tool cases and `WIRED_TOOL_NAMES` cannot drift apart (a parity
 * test pins it). Export tools bind their save-dialog metadata from `descriptor.dialog`, not a hardcoded
 * per-tool constant.
 */
export function buildToolRunner(
  db: Db,
  toolName: string,
  args: BuildRunnerArgs,
  audit: SkillToolAudit,
  deps: ToolRunDeps = {}
): ToolRunner | null {
  const descriptor = getToolDescriptor(toolName)
  if (!descriptor) return null // not wired (the canary / an unknown name) — nothing dispatches it
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
          layout: true,
          // An explicit "Extract transactions" click REPLACES the document's prior extraction, matching
          // the chat analysis path (`analysis/bank-statement.ts`) and the categorize doctask
          // (`doctasks/handlers/categorize.ts`), which both re-extract with `replaceExisting`. Without it
          // repeated clicks accumulated duplicate `bank_statements` rows, and `latestBankStatementId`
          // (newest wins) then served whichever extraction was last — so a chat answer and the button
          // could disagree on the row count for the same document.
          replaceExisting: true
        })
        // U-2 (audit 2026-06-26): a read-only "Extract transactions" click does NOT start the LLM
        // categorizer on its own. The earlier Phase-33 auto-offer silently enqueued a `categorize`
        // doctask here (invisible in the run bar, in the doctask lane) — a no-surprises violation for a
        // calm, privacy-posture app. The categorize is now an EXPLICIT one-tap offer on the run-bar
        // result row (renderer-side), targeting the same document; the model pass is user-initiated.
        return {
          ok: res.ok,
          count: res.transactionCount,
          cancelled: res.cancelled,
          errorCode: res.errorCode,
          error: res.error
        }
      }
    case 'validate_statement_balances':
      return async ({ signal, onProgress }) => {
        // Forward the faithful segment reader (+ bank geometry, D58): if the latest statement is STALE
        // the downstream seam re-extracts it (R3 / audit §5.6), and that re-extraction MUST read the
        // newline-preserving parser segments — the `chunks` table collapses newlines into near-zero rows.
        const res = await runBalanceValidation(db, seamArgs, {
          audit,
          signal,
          onProgress,
          readDocumentSegments: deps.readDocumentSegments,
          layout: true
        })
        return {
          ok: res.ok,
          count: res.count,
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
        // Segment reader forwarded for the stale re-extraction (R3 / §5.6). This direct-seam categorize
        // is the tests/headless path; with a doctask lane the categorize goes through the branch above.
        const res = await runCategorization(db, seamArgs, {
          audit,
          signal,
          onProgress,
          readDocumentSegments: deps.readDocumentSegments,
          layout: true
        })
        return { ok: res.ok, count: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'summarize_cashflow':
      return async ({ signal, onProgress }) => {
        const res = await runCashflowSummary(db, seamArgs, {
          audit,
          signal,
          onProgress,
          readDocumentSegments: deps.readDocumentSegments, // stale re-extraction reads faithful segments (R3 / §5.6)
          layout: true
        })
        return { ok: res.ok, count: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'export_transactions_csv':
      if (!deps.saveTextFile) return null // cannot export without the MAIN-side save capability
      return async ({ signal, onProgress }) => {
        const res = await runCsvExport(db, seamArgs, {
          audit,
          signal,
          onProgress,
          confirmed: args.confirmed,
          // Bind the CSV dialog from the tool's own descriptor (§6.2) rather than the seam's default.
          saveTextFile: (name, content) => deps.saveTextFile!(name, content, descriptor.dialog),
          readDocumentSegments: deps.readDocumentSegments, // an export of a STALE statement re-extracts first (R3 / §5.6)
          layout: true
        })
        return { ok: res.ok, count: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'extract_invoice':
      return async ({ signal, onProgress }) => {
        const res = await runInvoiceExtraction(db, seamArgs, {
          audit,
          signal,
          onProgress,
          readDocumentSegments: deps.readDocumentSegments,
          // Parity with the bank extract button + the invoice analysis path (`analysis/invoice.ts`,
          // which re-extracts with `replaceExisting`): an explicit re-extract REPLACES the document's
          // prior invoice rather than accumulating duplicate `invoices` rows that `latestInvoiceId`
          // would then pick between. (No layout flag on THIS run-bar path: the one invoice geometry
          // read is the analysis handler's P3 suspect retry, §42 — the run-bar extract stays
          // reading-order, D58 as amended.)
          replaceExisting: true
        })
        return {
          ok: res.ok,
          count: res.lineItemCount,
          cancelled: res.cancelled,
          errorCode: res.errorCode,
          error: res.error
        }
      }
    case 'validate_invoice_totals':
      return async ({ signal, onProgress }) => {
        // Segment reader forwarded so a STALE invoice re-extracts from faithful segments (R3 / §5.6).
        // No `layout` flag on this run-bar path — the one invoice geometry read is the analysis
        // handler's P3 suspect retry (§42); the run-bar extract stays reading-order (D58 as amended).
        const res = await runInvoiceTotalsValidation(db, seamArgs, {
          audit,
          signal,
          onProgress,
          readDocumentSegments: deps.readDocumentSegments
        })
        return {
          ok: res.ok,
          count: res.count,
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
          // Bind the CSV dialog from the tool's own descriptor (§6.2) rather than the seam's default.
          saveTextFile: (name, content) => deps.saveTextFile!(name, content, descriptor.dialog),
          readDocumentSegments: deps.readDocumentSegments // export of a STALE invoice re-extracts first (R3 / §5.6)
        })
        return { ok: res.ok, count: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'export_invoice_json':
    case 'export_invoice_xml':
      if (!deps.saveTextFile) return null // cannot export without the MAIN-side save capability
      return async ({ signal, onProgress }) => {
        const res = await runInvoiceFileExport(
          db,
          seamArgs,
          {
            audit,
            signal,
            onProgress,
            confirmed: args.confirmed,
            // §6.2: bind the format's OWN save-dialog metadata (title/filter/.json|.xml) from the tool's
            // descriptor so the dialog no longer serves the CSV title/filter to a JSON/XML export.
            saveTextFile: (name, content) => deps.saveTextFile!(name, content, descriptor.dialog),
            readDocumentSegments: deps.readDocumentSegments // JSON/XML export of a STALE invoice re-extracts first (R3 / §5.6)
          },
          {
            toolName,
            defaultFileName: toolName === 'export_invoice_json' ? 'invoice.json' : 'invoice.xml'
          }
        )
        return { ok: res.ok, count: res.count, cancelled: res.cancelled, errorCode: res.errorCode, error: res.error }
      }
    case 'redact_document':
      if (!deps.saveTextFile) return null // cannot save the redacted copy without the MAIN-side capability
      return async ({ signal, onProgress }) => {
        const res = await runDocumentRedaction(db, seamArgs, {
          audit,
          signal,
          onProgress,
          confirmed: args.confirmed,
          // §6.2: the redacted copy gets its own "Save redacted copy" dialog + a .txt filter (from the
          // descriptor), instead of the "Export transactions" / .csv dialog that fought the saved filename.
          saveTextFile: (name, content) => deps.saveTextFile!(name, content, descriptor.dialog),
          readDocumentSegments: deps.readDocumentSegments,
          // Phase 7 (D73): the LLM locate pass runs main-side in the seam via this runtime. Null ⇒ the
          // run degrades to the deterministic floor with an honest note (never a silent partial).
          runtime: deps.runtime ?? null
        })
        return {
          ok: res.ok,
          count: res.redactionCount,
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
