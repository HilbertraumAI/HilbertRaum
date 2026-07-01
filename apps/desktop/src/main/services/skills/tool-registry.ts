import type {
  JsonSchema,
  SkillTool,
  SkillToolContext,
  ToolPermission,
  ToolResult
} from '../../../shared/types'
import {
  categorizeTransactionsTool,
  exportTransactionsCsvTool,
  extractTransactionsTool,
  summarizeCashflowTool,
  validateStatementBalancesTool
} from './tools/bank-statement'
import {
  exportInvoiceCsvTool,
  exportInvoiceJsonTool,
  exportInvoiceXmlTool,
  extractInvoiceTool,
  validateInvoiceTotalsTool
} from './tools/invoice'
import { redactDocumentTool } from './tools/redaction'

// Tier-2 skill tool registry + the validate→run→validate gate (skills plan §12, Phase S10).
//
// DESIGN, not a feature wave: S10 ships the *gate* and exactly ONE harmless, read-only reference
// tool to prove it end-to-end. NO bank-statement tools (extract_transactions et al. are S11), NO
// `skill_runs` table, NO data tables, NO IPC wiring. The gate is APP-ORCHESTRATED (DS4/§2): it is
// invoked directly by the app/tests, never by the model parsing `tool_calls`.
//
// The trust shape (skills plan §4/§12.2/§14):
//   - A skill can never REGISTER a tool. Tools live only in the static `REGISTRY` below; a skill
//     merely *declares* names via `allowedTools`. The effective set is the three-way intersection
//     `declared ∩ registry ∩ userGrant` (`resolveEffectiveTools`).
//   - Input is validated against `inputSchema` BEFORE `run`; invalid input is refused without ever
//     calling the tool. Output is validated against `outputSchema` AFTER `run`; a wrong-shape result
//     fails the run so no half-trusted output reaches the model.
//   - A write/export/destructive tool requires explicit user confirmation; a read-only tool runs
//     without a per-call prompt (still surfaced by the app).
//   - The tool runs inside a NARROW `SkillToolContext` (shared/types) — a fixed, frozen `documentIds`
//     scope it cannot widen, plus cancellation/progress/audit. No `Db`/SQL/FS/network handle exists.
//   - Audit is ids/counts only (`{skillId, toolName, documentCount}`); inputs/outputs/content never
//     touch the audit log or the renderer (§22-M1). Technical failure reasons go to the local log.
//
// This file is pure main-side TS: no `node:fs`, no network, no native deps (CLAUDE.md §0).

// ---- JSON Schema (subset) validation ----

/**
 * Validate a value against the `JsonSchema` subset (shared/types). Returns a list of STRUCTURAL
 * error strings (empty ⇒ valid). It never echoes input VALUES — only schema-defined property names
 * and the dotted path — so its output is safe to reason about without leaking content (§22-M1).
 * Pure; the gate maps these to a single friendly, content-free message before anything is surfaced.
 */
export function validateJsonSchema(schema: JsonSchema, value: unknown, path = 'value'): string[] {
  const errors: string[] = []
  validateNode(schema, value, path, errors)
  return errors
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.enum !== undefined && !schema.enum.some((e) => e === value)) {
    errors.push(`${path} is not one of the allowed values`)
  }
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path} must be an object`)
        return
      }
      const props = schema.properties ?? {}
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${path}.${key} is required`)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          // Do NOT echo the offending key — it originates in the input and could carry content.
          if (!(key in props)) {
            errors.push(`${path} has an unexpected property`)
            break
          }
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in value) validateNode(sub, value[key], `${path}.${key}`, errors)
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`)
        return
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path} must have at least ${schema.minItems} items`)
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path} must have at most ${schema.maxItems} items`)
      }
      if (schema.items) {
        value.forEach((item, i) => validateNode(schema.items as JsonSchema, item, `${path}[${i}]`, errors))
      }
      return
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path} must be a string`)
        return
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path} is too short`)
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path} is too long`)
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        errors.push(`${path} is not in the expected format`)
      }
      return
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path} must be a number`)
        return
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        errors.push(`${path} must be a whole number`)
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path} must be at least ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path} must be at most ${schema.maximum}`)
      }
      return
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path} must be true or false`)
      return
    }
    case 'null': {
      if (value !== null) errors.push(`${path} must be null`)
      return
    }
    default:
      // No `type` keyword ⇒ no type constraint (enum, if any, was already checked).
      return
  }
}

/** Validate a tool's input against its `inputSchema`. Returns structural errors (empty ⇒ valid). */
export function validateToolInput(tool: SkillTool, input: unknown): string[] {
  return validateJsonSchema(tool.inputSchema, input, 'input')
}

/** Validate a tool's output against its `outputSchema` (no schema ⇒ accepted). */
export function validateToolOutput(tool: SkillTool, output: unknown): string[] {
  if (!tool.outputSchema) return []
  return validateJsonSchema(tool.outputSchema, output, 'output')
}

// ---- Permission model ----

/** Tokens that imply a write/export/destructive action ⇒ require explicit user confirmation. */
const CONFIRM_PERMISSIONS: ReadonlySet<ToolPermission> = new Set<ToolPermission>([
  'write-generated-doc',
  'export-file'
])

/**
 * True when a tool needs the user to confirm before it runs (skills plan §12.2): any
 * write/export/destructive permission. Read-only tools (`read-selected-docs`) return false. The app
 * uses this to decide whether to raise the confirm modal; the gate enforces it defensively.
 */
export function toolRequiresConfirmation(tool: SkillTool): boolean {
  return tool.permissions.some((p) => CONFIRM_PERMISSIONS.has(p))
}

// ---- The registry (app-owned, static) ----

/**
 * The ONE shipped reference tool (skills plan §18.1) — proves the gate end-to-end. Pure, offline,
 * read-only: it reports HOW MANY documents are in the turn's selected scope and nothing else. It
 * reads only the fixed `ctx.documentIds` (ids/count), touches no DB/FS/network, and has no side
 * effects — so it needs only `read-selected-docs` and no confirmation. NO bank-statement tool ships
 * in S10 (those are S11).
 *
 * X-2 (audit 2026-06-26) — KEPT DELIBERATELY as the gate's test-only CANARY, not dead code. No bundled
 * skill declares it and it is intentionally NOT wired to a `run.ts` dispatch seam (`tool-runs.ts`
 * `buildToolRunner` returns null for it), so it is registry-only and exposes NO live capability. It is
 * the minimal reference the gate tests run end-to-end (`skills-tool-registry.test.ts`,
 * `skills-tool-run-ipc.test.ts`). Removing it would churn those tests for no behaviour gain; keeping
 * it documented here stops it being mistaken for an orphan to delete OR a capability to wire up.
 */
const countSelectedDocumentsTool: SkillTool = {
  name: 'count_selected_documents',
  description:
    'Report how many documents are selected for this turn. Read-only; sees only the selected-document scope.',
  permissions: ['read-selected-docs'],
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['documentCount'],
    properties: { documentCount: { type: 'integer', minimum: 0 } }
  },
  async run(_input, ctx) {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    return { ok: true, output: { documentCount: ctx.documentIds.length } }
  }
}

/**
 * The static, app-owned tool map. A skill can never add to it (skills plan §12.2). Bank-statement
 * tools are DEFINED in `tools/bank-statement.ts` (bank specifics stay out of the generic infra,
 * §13) and merely listed here. S11a wired `extract_transactions`; S11c adds the remaining four
 * bank tools (validate/categorize/summarize read-only; export confirm-gated `export-file`). The
 * INVOICE tools (`tools/invoice.ts`) are the SECOND Tier-2 domain proving the gate generalizes —
 * same shape (extract read-only; validate read-only; export confirm-gated), a separate content class.
 * REDACTION (`tools/redaction.ts`) is the read-transform-export shape: a single `redact_document`
 * tool that reads the selected document and produces a masked copy the seam writes (confirm-gated
 * `export-file`); it persists no rows (the deliverable is the file).
 */
const REGISTRY: Record<string, SkillTool> = {
  [countSelectedDocumentsTool.name]: countSelectedDocumentsTool, // test-only gate canary, not wired (X-2)
  [extractTransactionsTool.name]: extractTransactionsTool,
  [validateStatementBalancesTool.name]: validateStatementBalancesTool,
  [categorizeTransactionsTool.name]: categorizeTransactionsTool,
  [summarizeCashflowTool.name]: summarizeCashflowTool,
  [exportTransactionsCsvTool.name]: exportTransactionsCsvTool,
  [extractInvoiceTool.name]: extractInvoiceTool,
  [validateInvoiceTotalsTool.name]: validateInvoiceTotalsTool,
  [exportInvoiceCsvTool.name]: exportInvoiceCsvTool,
  [exportInvoiceJsonTool.name]: exportInvoiceJsonTool,
  [exportInvoiceXmlTool.name]: exportInvoiceXmlTool,
  [redactDocumentTool.name]: redactDocumentTool
}

/** Look up a registered tool by name (own-property only — never reaches `Object.prototype`). */
export function getRegisteredTool(name: string): SkillTool | undefined {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name) ? REGISTRY[name] : undefined
}

/** All registered tool names (stable insertion order). */
export function listRegisteredToolNames(): string[] {
  return Object.keys(REGISTRY)
}

/**
 * The effective tool set for a skill: `declared ∩ registry ∩ userGrant` (skills plan §12.2). A
 * declared name that is not in the registry is dropped (a skill can never register a tool); a name
 * the user has not granted is dropped. Declared order is preserved and duplicates collapsed.
 */
export function resolveEffectiveTools(declared: string[], userGrant: string[]): string[] {
  const granted = new Set(userGrant)
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of declared) {
    if (seen.has(name)) continue
    if (getRegisteredTool(name) === undefined) continue // ∩ registry
    if (!granted.has(name)) continue // ∩ userGrant
    seen.add(name)
    out.push(name)
  }
  return out
}

// ---- The validate → run → validate gate ----

export interface RunSkillToolArgs {
  /** The skill (its `install_id`) requesting the run — for ids/counts-only audit. */
  skillId: string
  /** The raw input to validate then pass to the tool. */
  input: unknown
  /** The narrow context the app built (its `documentIds` is frozen by the gate before the run). */
  ctx: SkillToolContext
  /** True once the user has confirmed a write/export/destructive tool (skills plan §12.2). */
  confirmed?: boolean
}

/**
 * Run a tool through the gate (skills plan §12.2). The order is fixed:
 *   1. cancelled? → refuse (no run, no audit).
 *   2. validate INPUT → refuse without calling the tool if it fails (no run, no audit).
 *   3. needs confirmation but not confirmed? → refuse (no run, no audit).
 *   4. audit `skill_run_started`, run with a FROZEN `documentIds` (cannot be widened).
 *   5. validate OUTPUT → a wrong shape fails the run; the output never reaches the caller/model.
 *   6. audit `skill_run_done` (ok) / `skill_run_failed` (threw, returned !ok, or bad output).
 *
 * All surfaced errors are FRIENDLY and content-free; technical reasons go to the local log only.
 * The gate persists nothing — there is no partial-result to leak (no-partial-persist, §12.2).
 */
export async function runSkillTool(tool: SkillTool, args: RunSkillToolArgs): Promise<ToolResult> {
  const { skillId, input, ctx, confirmed } = args
  // ids/counts ONLY — the single audit payload, reused for every event (§22-M1).
  const auditMeta = { skillId, toolName: tool.name, documentCount: ctx.documentIds.length }

  // --- pre-run gates: refuse cleanly; nothing ran, so nothing is audited as a run. ---
  if (ctx.signal.aborted) {
    return { ok: false, error: 'This action was cancelled.' }
  }
  if (validateToolInput(tool, input).length > 0) {
    return { ok: false, error: 'This tool was given input it cannot accept.' }
  }
  if (toolRequiresConfirmation(tool) && confirmed !== true) {
    return { ok: false, error: 'This tool needs your confirmation before it can run.' }
  }

  // --- the run, bracketed by ids/counts-only audit ---
  ctx.audit('skill_run_started', auditMeta)
  // A FROZEN shallow copy: the tool sees the fixed scope and cannot widen it (§14).
  const safeCtx: SkillToolContext = { ...ctx, documentIds: Object.freeze([...ctx.documentIds]) }

  // A run that did not finish because it was CANCELLED is recorded by the seam as `cancelled` (the
  // `skill_runs` row), NOT a failure. The audit surface has no `skill_run_cancelled` event (it is
  // ids/counts-only — §11), so to keep the audit consistent with the row we SUPPRESS the
  // `skill_run_failed` event whenever the abort signal has fired: a cancelled run audits as
  // started-then-no-terminal-event, never as a failure (the cancel-vs-outcome consistency, B1/B2).
  const auditTerminalFailure = (): void => {
    if (ctx.signal.aborted) return
    ctx.audit('skill_run_failed', auditMeta)
  }

  let result: ToolResult
  try {
    result = await tool.run(input, safeCtx)
  } catch {
    // Technical reason to the LOCAL log only — never the renderer, never the audit (§12.2/§22-M1).
    console.error(`[skills] tool "${tool.name}" threw during run`)
    auditTerminalFailure()
    return { ok: false, error: 'This tool could not finish. Nothing was changed.' }
  }

  if (!result.ok) {
    auditTerminalFailure()
    return result // the tool's own friendly, content-free error
  }

  if (validateToolOutput(tool, result.output).length > 0) {
    // Wrong-shape output is NOT half-trusted into the model — the run fails (§12.2).
    console.error(`[skills] tool "${tool.name}" returned output failing its schema`)
    auditTerminalFailure()
    return { ok: false, error: 'This tool produced an unexpected result and was stopped.' }
  }

  ctx.audit('skill_run_done', auditMeta)
  return result
}
