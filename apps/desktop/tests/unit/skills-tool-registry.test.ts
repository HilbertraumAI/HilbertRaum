import { describe, it, expect } from 'vitest'
import {
  validateJsonSchema,
  validateToolInput,
  validateToolOutput,
  toolRequiresConfirmation,
  getRegisteredTool,
  listRegisteredToolNames,
  resolveWiredTools,
  runSkillTool
} from '../../src/main/services/skills/tool-registry'
import {
  SKILL_TOOL_DESCRIPTORS,
  WIRED_TOOL_NAMES,
  getToolDescriptor
} from '../../src/shared/skill-tools'
import type {
  AuditEventType,
  SkillTool,
  SkillToolContext,
  ToolResult
} from '../../src/shared/types'

// Skills plan §12 / Phase S10 — the Tier-2 tool registry + the validate→run→validate gate, proven
// in isolation (app-orchestrated, never the model). Covers: input-validate-before-run, output-shape
// rejection, the declared ∩ registry ∩ userGrant intersection, the narrow frozen context, the
// write/export confirm gate, AbortSignal cancellation, and the §22-M1 ids/counts-only audit (a
// sentinel pushed through a run never appears in the audit payload). Pure, no Electron, no DB.

const SENTINEL = 'XTOOL_SENTINEL_my_secret_account_99999'

interface CapturedEvent {
  type: AuditEventType
  meta?: Record<string, unknown>
}

function makeCtx(over: Partial<SkillToolContext> = {}): {
  ctx: SkillToolContext
  events: CapturedEvent[]
} {
  const events: CapturedEvent[] = []
  const ctx: SkillToolContext = {
    documentIds: [],
    readDocumentChunks: () => [],
    signal: new AbortController().signal,
    audit: (type, meta) => {
      events.push({ type, meta })
    },
    ...over
  }
  return { ctx, events }
}

// A read-only tool that echoes a free-text note — used to push a sentinel through a SUCCESSFUL run.
const noteTool: SkillTool = {
  name: 'echo_note_test_only',
  description: 'test-only',
  permissions: ['read-selected-docs'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['note'],
    properties: { note: { type: 'string', minLength: 1 } }
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['length'],
    properties: { length: { type: 'integer', minimum: 0 } }
  },
  async run(input) {
    const note = (input as { note: string }).note
    return { ok: true, output: { length: note.length } }
  }
}

describe('validateJsonSchema (subset)', () => {
  it('accepts a conforming object and rejects unexpected / missing / wrong-typed properties', () => {
    const schema = {
      type: 'object' as const,
      additionalProperties: false,
      required: ['n'],
      properties: { n: { type: 'integer' as const, minimum: 0 } }
    }
    expect(validateJsonSchema(schema, { n: 3 })).toEqual([])
    expect(validateJsonSchema(schema, { n: 1, extra: 1 }).length).toBeGreaterThan(0) // additionalProperties:false
    expect(validateJsonSchema(schema, {}).length).toBeGreaterThan(0) // missing required
    expect(validateJsonSchema(schema, { n: 1.5 }).length).toBeGreaterThan(0) // not an integer
    expect(validateJsonSchema(schema, { n: -1 }).length).toBeGreaterThan(0) // below minimum
    expect(validateJsonSchema(schema, 'nope').length).toBeGreaterThan(0) // not an object
  })

  it('validates strings (pattern/length), arrays (items/bounds) and enums', () => {
    expect(validateJsonSchema({ type: 'string', pattern: '^[A-Z]{3}$' }, 'EUR')).toEqual([])
    expect(validateJsonSchema({ type: 'string', pattern: '^[A-Z]{3}$' }, 'eur').length).toBe(1)
    expect(validateJsonSchema({ type: 'array', items: { type: 'string' }, minItems: 1 }, ['a'])).toEqual([])
    expect(validateJsonSchema({ type: 'array', items: { type: 'string' } }, [1]).length).toBe(1)
    expect(validateJsonSchema({ enum: ['a', 'b'] }, 'a')).toEqual([])
    expect(validateJsonSchema({ enum: ['a', 'b'] }, 'c').length).toBe(1)
  })

  it('never echoes the input VALUE in an error message (§22-M1)', () => {
    const schema = { type: 'object' as const, additionalProperties: false, properties: {} }
    const errors = validateJsonSchema(schema, { [SENTINEL]: SENTINEL })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).not.toContain(SENTINEL)
  })
})

describe('registry + resolveWiredTools', () => {
  it('ships the reference tool + the bank tools + the invoice tools + the redaction tool', () => {
    // `count_selected_documents` is the gate's test-only CANARY — registered but never wired (X-2, kept
    // deliberately; the "not wired to a run seam" half is pinned in skills-tool-run-ipc.test.ts).
    expect(listRegisteredToolNames()).toEqual([
      'count_selected_documents',
      'extract_transactions',
      'validate_statement_balances',
      'categorize_transactions',
      'summarize_cashflow',
      'export_transactions_csv',
      // Invoice — the SECOND Tier-2 domain (same gate, second content class).
      'extract_invoice',
      'validate_invoice_totals',
      'export_invoice_csv',
      'export_invoice_json',
      'export_invoice_xml',
      // Redaction — the read-transform-export shape (confirm-gated; no content-class table).
      'redact_document'
    ])
    expect(getRegisteredTool('export_transactions_csv')).toBeDefined()
    expect(getRegisteredTool('extract_invoice')).toBeDefined()
    expect(getRegisteredTool('redact_document')).toBeDefined()
    expect(getRegisteredTool('__proto__')).toBeUndefined() // own-property lookup only
  })

  it('resolves declared ∩ registry ∩ wired; drops the unwired canary + unregistered names; dedups; keeps order', () => {
    // A2 (audit §6.4-low): the vestigial `userGrant` leg is gone — the set is declared ∩ registry ∩ wired.
    // `count_selected_documents` is REGISTERED but not WIRED (the X-2 canary), so it is dropped here.
    expect(
      resolveWiredTools(['count_selected_documents', 'export_transactions_csv', 'count_selected_documents'])
    ).toEqual(['export_transactions_csv'])
    // The registered-but-unwired canary alone → [] (nothing dispatches it).
    expect(resolveWiredTools(['count_selected_documents'])).toEqual([])
    // A declared-but-unregistered tool is dropped (a skill can never register a tool).
    expect(resolveWiredTools(['made_up_tool'])).toEqual([])
    // Declared order preserved; duplicates collapsed; only wired names survive.
    expect(resolveWiredTools(['export_invoice_json', 'extract_transactions', 'export_invoice_json'])).toEqual([
      'export_invoice_json',
      'extract_transactions'
    ])
  })
})

// A2 (audit §6.2) — the self-describing tool registry: one descriptor per WIRED tool is the single
// source the wired-list, runner dispatch, renderer maps and save-dialog metadata all derive from. These
// pin the descriptor table against the app-owned registry so the two can never drift apart.
describe('self-describing tool registry (A2)', () => {
  it('every wired descriptor names a registered tool; the only registered tool WITHOUT a descriptor is the X-2 canary', () => {
    for (const d of SKILL_TOOL_DESCRIPTORS) {
      expect(getRegisteredTool(d.name), `${d.name} must be registered`).toBeDefined()
    }
    const registeredWithoutDescriptor = listRegisteredToolNames().filter((n) => !getToolDescriptor(n))
    expect(registeredWithoutDescriptor).toEqual(['count_selected_documents'])
  })

  it('WIRED_TOOL_NAMES equals the descriptor order and excludes the canary', () => {
    expect(WIRED_TOOL_NAMES).toEqual(SKILL_TOOL_DESCRIPTORS.map((d) => d.name))
    expect(WIRED_TOOL_NAMES).not.toContain('count_selected_documents')
  })

  it('descriptor.confirm agrees with the permission-derived toolRequiresConfirmation (no drift)', () => {
    for (const d of SKILL_TOOL_DESCRIPTORS) {
      const tool = getRegisteredTool(d.name)!
      expect(d.confirm, `${d.name} confirm must match its permissions`).toBe(toolRequiresConfirmation(tool))
    }
  })

  it('every export tool carries a save dialog; non-export tools carry none', () => {
    for (const d of SKILL_TOOL_DESCRIPTORS) {
      if (d.seamKind === 'export') expect(d.dialog, `${d.name} export needs a dialog`).toBeDefined()
      else expect(d.dialog, `${d.name} is not an export and must not carry a dialog`).toBeUndefined()
    }
  })

  it('each result-shape descriptor carries the copy keys its shape needs', () => {
    for (const d of SKILL_TOOL_DESCRIPTORS) {
      if (d.resultShape === 'reconcile') expect(d.reconcileKeys, `${d.name} reconcile keys`).toBeDefined()
      if (d.resultShape === 'redaction') expect(d.redactionKeys, `${d.name} redaction keys`).toBeDefined()
    }
  })
})

describe('toolRequiresConfirmation', () => {
  it('is false for a read-only tool and true for write/export tools', () => {
    expect(toolRequiresConfirmation(getRegisteredTool('count_selected_documents')!)).toBe(false)
    const writeTool: SkillTool = { ...noteTool, permissions: ['write-generated-doc'] }
    const exportTool: SkillTool = { ...noteTool, permissions: ['read-selected-docs', 'export-file'] }
    expect(toolRequiresConfirmation(writeTool)).toBe(true)
    expect(toolRequiresConfirmation(exportTool)).toBe(true)
  })
})

describe('runSkillTool — the validate→run→validate gate', () => {
  it('runs the reference tool over the fixed scope and audits started+done (ids/counts only)', async () => {
    const { ctx, events } = makeCtx({ documentIds: ['d1', 'd2', 'd3'] })
    const tool = getRegisteredTool('count_selected_documents')!
    const result = await runSkillTool(tool, { skillId: 'user:demo', input: {}, ctx })
    expect(result).toEqual({ ok: true, output: { documentCount: 3 } })
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
    for (const e of events) {
      expect(e.meta).toEqual({ skillId: 'user:demo', toolName: 'count_selected_documents', documentCount: 3 })
    }
  })

  it('refuses invalid input WITHOUT calling the tool (no run audited)', async () => {
    const { ctx, events } = makeCtx({ documentIds: ['d1'] })
    let ran = false
    const tool: SkillTool = {
      ...getRegisteredTool('count_selected_documents')!,
      async run() {
        ran = true
        return { ok: true, output: { documentCount: 0 } }
      }
    }
    const result = await runSkillTool(tool, { skillId: 's', input: { unexpected: 1 }, ctx })
    expect(result.ok).toBe(false)
    expect(ran).toBe(false)
    expect(events).toEqual([]) // nothing ran ⇒ no skill_run_* event
  })

  it('fails a run whose OUTPUT is the wrong shape; the output never reaches the caller', async () => {
    const { ctx, events } = makeCtx()
    const badTool: SkillTool = {
      ...noteTool,
      async run() {
        return { ok: true, output: { length: 'not-a-number' } } // violates outputSchema
      }
    }
    const result = await runSkillTool(badTool, { skillId: 's', input: { note: 'hi' }, ctx })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain('not-a-number')
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_failed'])
  })

  it('audits skill_run_failed when the tool throws, with a friendly content-free error', async () => {
    const { ctx, events } = makeCtx()
    const throwTool: SkillTool = {
      ...noteTool,
      async run() {
        throw new Error(SENTINEL)
      }
    }
    const result = await runSkillTool(throwTool, { skillId: 's', input: { note: 'hi' }, ctx })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain(SENTINEL)
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_failed'])
  })
})

describe('runSkillTool — confirmation gate', () => {
  const writeTool: SkillTool = {
    ...noteTool,
    permissions: ['write-generated-doc']
  }

  it('refuses a write tool without confirmation (does not run)', async () => {
    const { ctx, events } = makeCtx()
    let ran = false
    const tool: SkillTool = { ...writeTool, async run() { ran = true; return { ok: true, output: { length: 0 } } } }
    const result = await runSkillTool(tool, { skillId: 's', input: { note: 'x' }, ctx })
    expect(result.ok).toBe(false)
    expect(ran).toBe(false)
    expect(events).toEqual([])
  })

  it('runs a write tool once confirmed:true', async () => {
    const { ctx, events } = makeCtx()
    const result = await runSkillTool(writeTool, { skillId: 's', input: { note: 'x' }, ctx, confirmed: true })
    expect(result.ok).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })
})

describe('runSkillTool — narrow context + cancellation', () => {
  it('hands the tool a FROZEN documentIds it cannot widen, and no fs/net/sql handle', async () => {
    const { ctx } = makeCtx({ documentIds: ['d1', 'd2'] })
    let captured: SkillToolContext | undefined
    const tool: SkillTool = {
      ...noteTool,
      async run(_input, c) {
        captured = c
        try {
          ;(c.documentIds as string[]).push('d3') // attempt to widen the scope
        } catch {
          // frozen ⇒ TypeError in strict mode; swallow and report the unchanged length
        }
        return { ok: true, output: { length: c.documentIds.length } }
      }
    }
    const result = await runSkillTool(tool, { skillId: 's', input: { note: 'x' }, ctx })
    expect(result).toEqual({ ok: true, output: { length: 2 } }) // scope not widened
    expect(Object.isFrozen(captured!.documentIds)).toBe(true)
    // The whole reach of a tool: documentIds + the scope-bounded readDocumentChunks + signal + audit
    // (+ optional onProgress). No db/fs/net/sql handle.
    const keys = Object.keys(captured!).sort()
    expect(keys).toEqual(['audit', 'documentIds', 'readDocumentChunks', 'signal'])
    for (const forbidden of ['db', 'fs', 'net', 'sql', 'fetch', 'exec']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('refuses to start when the signal is already aborted (the tool never runs)', async () => {
    const ac = new AbortController()
    ac.abort()
    const { ctx, events } = makeCtx({ signal: ac.signal, documentIds: ['d1'] })
    let ran = false
    const tool: SkillTool = {
      ...getRegisteredTool('count_selected_documents')!,
      async run() { ran = true; return { ok: true, output: { documentCount: 0 } } }
    }
    const result = await runSkillTool(tool, { skillId: 's', input: {}, ctx })
    expect(result.ok).toBe(false)
    expect(ran).toBe(false)
    expect(events).toEqual([])
  })

  it('a tool returning !ok AFTER the abort fired audits no skill_run_failed (cancel ⇄ row consistency)', async () => {
    // A mid-run cancel: the signal fires while the tool is working, then the tool returns !ok. The
    // run seam records the `skill_runs` row as `cancelled`; the gate must NOT audit it as
    // `skill_run_failed`, or the audit would contradict the row. Expect started-then-no-terminal.
    const ac = new AbortController()
    const { ctx, events } = makeCtx({ signal: ac.signal, documentIds: ['d1'] })
    const cancelTool: SkillTool = {
      ...noteTool,
      async run() {
        ac.abort() // the user cancelled mid-run
        return { ok: false, error: 'This action was cancelled.' }
      }
    }
    const result = await runSkillTool(cancelTool, { skillId: 's', input: { note: 'x' }, ctx })
    expect(result.ok).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['skill_run_started'])
    expect(events.map((e) => e.type)).not.toContain('skill_run_failed')
  })

  it('a genuine !ok with NO abort still audits skill_run_failed (the non-cancel path is unchanged)', async () => {
    const { ctx, events } = makeCtx({ documentIds: ['d1'] })
    const failTool: SkillTool = {
      ...noteTool,
      async run() {
        return { ok: false, error: 'This tool could not finish.' }
      }
    }
    const result = await runSkillTool(failTool, { skillId: 's', input: { note: 'x' }, ctx })
    expect(result.ok).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_failed'])
  })
})

describe('runSkillTool — content-class sentinel grep (§22-M1)', () => {
  it('never lets input/output/content reach the audit payload', async () => {
    const { ctx, events } = makeCtx({ documentIds: ['d1'] })
    // The note carries the sentinel; the run succeeds (output is just its length).
    const result: ToolResult = await runSkillTool(noteTool, {
      skillId: 'user:secret',
      input: { note: SENTINEL },
      ctx
    })
    expect(result.ok).toBe(true)
    expect(events.length).toBe(2)
    // The whole captured audit stream — types + metadata — must be free of the sentinel.
    expect(JSON.stringify(events)).not.toContain(SENTINEL)
    for (const e of events) {
      expect(e.meta).toEqual({ skillId: 'user:secret', toolName: 'echo_note_test_only', documentCount: 1 })
    }
  })
})

describe('validateToolInput / validateToolOutput helpers', () => {
  it('thread through to the tool schemas', () => {
    const tool = getRegisteredTool('count_selected_documents')!
    expect(validateToolInput(tool, {})).toEqual([])
    expect(validateToolInput(tool, { x: 1 }).length).toBeGreaterThan(0)
    expect(validateToolOutput(tool, { documentCount: 2 })).toEqual([])
    expect(validateToolOutput(tool, { documentCount: -1 }).length).toBeGreaterThan(0)
  })
})
