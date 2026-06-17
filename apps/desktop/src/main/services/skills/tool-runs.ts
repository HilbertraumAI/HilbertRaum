import type { Db } from '../db'
import type { AuditRecorder } from '../audit'
import type { AuditEventType, RunnableTool, SkillToolAudit } from '../../../shared/types'
import type { SkillRecord } from './registry'
import { resolveScope } from '../collections'
import { buildScopeFilter } from '../retrieval-scope'
import { getRegisteredTool, toolRequiresConfirmation } from './tool-registry'
import { runBankExtraction } from './run'
import type { ToolRunner } from './run-controller'

// The app-orchestrated tool-run DISPATCH (skills plan §6/§12.2, Phase S11b). This is the ONE place
// that maps a registry tool name to its persistence seam (`run.ts`) and so is allowed to know bank
// specifics — exactly as `tools/bank-statement.ts` is (§13). The generic infra (the run controller,
// registerSkillsIpc, the renderer) stays bank-free and talks only in `RunnableTool`/handles.
//
// S11b wires ONLY `extract_transactions` (read-only, no confirm). S11c adds the write/export tools
// (e.g. `export_transactions_csv`) by adding a case here — the channel/controller/renderer don't change.

/** The tools whose run seam is wired in this phase. S11c extends this set. */
const WIRED_TOOL_NAMES: readonly string[] = ['extract_transactions']

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
 * The wired tool names a skill may run (skills plan §12.2, S11b). A skill that RESERVES Tier-2 tools
 * (the honest `reservesTools` signal — the same one the S5 detail-drawer note triggers on) is offered
 * the wired tools. The instruction-kind parser discards the DECLARED tool *names* (S9/SL-1), so v1
 * cannot intersect per-skill; in v1 the bank-statement skill is the only `reservesTools` skill and
 * `extract_transactions` safely no-ops on a non-statement (it drops every row it can't parse). When
 * S11c flips the skill to `kind:'tool'`, switch this to the effective `allowedTools ∩ registry ∩
 * userGrant` set (`resolveEffectiveTools`).
 */
export function runnableToolNames(skill: SkillRecord): string[] {
  const reserves = skill.manifest.reservesTools === true || skill.manifest.allowedTools.length > 0
  if (!reserves) return []
  return WIRED_TOOL_NAMES.filter((n) => getRegisteredTool(n) !== undefined)
}

/** The `RunnableTool` descriptors for a skill (name + whether the renderer must confirm first). */
export function runnableToolsForSkill(skill: SkillRecord): RunnableTool[] {
  return runnableToolNames(skill).map((name) => ({
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
 * Build the `ToolRunner` for a wired tool (or `null` if the tool is not wired this phase). The runner
 * closes over the right `run.ts` seam + the ids/counts-only audit and resolves to a content-free
 * outcome. The controller never sees content — persistence + the extracted rows stay in the seam.
 */
export function buildToolRunner(
  db: Db,
  toolName: string,
  args: BuildRunnerArgs,
  audit: SkillToolAudit
): ToolRunner | null {
  if (toolName === 'extract_transactions') {
    return async ({ signal, onProgress }) => {
      const res = await runBankExtraction(
        db,
        {
          skillInstallId: args.skillInstallId,
          conversationId: args.conversationId,
          documentId: args.documentId
        },
        { audit, signal, onProgress }
      )
      return { ok: res.ok, transactionCount: res.transactionCount, error: res.error }
    }
  }
  // S11c: export_transactions_csv et al. plug in here (confirm-gated via toolRunNeedsConfirmation).
  return null
}
