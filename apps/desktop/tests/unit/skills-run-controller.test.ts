import { describe, it, expect } from 'vitest'
import { SkillRunController, type ToolRunner } from '../../src/main/services/skills/run-controller'
import { runSkillTool } from '../../src/main/services/skills/tool-registry'
import type { SkillTool, SkillToolContext } from '../../src/shared/types'

// docs/skills-s11-plan.md §6/§2 (S11b) — the GENERIC tool-run lifecycle controller: running →
// terminal, progress merge, Cancel via the AbortSignal, one-at-a-time, and the write/export
// CONFIRM gate exercised end-to-end with a SYNTHETIC write tool (proving S11c's export tool gates).

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function waitForTerminal(controller: SkillRunController, handle: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const s = controller.get(handle)
    if (s && s.state !== 'running') return s.state
    await flush()
  }
  throw new Error('run did not terminate')
}

describe('SkillRunController (S11b)', () => {
  it('runs to done, merges progress, and reports the count', async () => {
    const c = new SkillRunController()
    const runner: ToolRunner = async ({ onProgress }) => {
      onProgress({ done: 1, total: 2 })
      return { ok: true, transactionCount: 7 }
    }
    const initial = c.start({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', documentCount: 1, runner })
    expect(initial.state).toBe('running')
    expect(c.isRunning()).toBe(true)
    expect(await waitForTerminal(c, initial.runHandle)).toBe('done')
    const final = c.get(initial.runHandle)!
    expect(final.transactionCount).toBe(7)
    expect(final.progress).toEqual({ done: 1, total: 2 })
    expect(c.isRunning()).toBe(false)
  })

  it('cancel aborts the run and marks it cancelled (no done)', async () => {
    const c = new SkillRunController()
    const runner: ToolRunner = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false }))
      })
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentCount: 1, runner })
    c.cancel(runHandle)
    expect(await waitForTerminal(c, runHandle)).toBe('cancelled')
  })

  it('refuses a second run while one is in flight (one-at-a-time)', () => {
    const c = new SkillRunController()
    const runner: ToolRunner = ({ signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false })))
    c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentCount: 1, runner })
    expect(() => c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentCount: 1, runner })).toThrow()
  })

  it('clear() drops a terminal run so the next can start', async () => {
    const c = new SkillRunController()
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentCount: 1, runner: async () => ({ ok: true }) })
    await waitForTerminal(c, runHandle)
    c.clear(runHandle)
    expect(c.get(runHandle)).toBeNull()
  })

  // The CONFIRM gate, proven through a SYNTHETIC write tool driven by the real gate (`runSkillTool`)
  // inside a controller run — exactly the shape S11c's `export_transactions_csv` will use.
  const writeTool: SkillTool = {
    name: 'synthetic_write',
    description: 'A synthetic write/export tool (test only).',
    permissions: ['write-generated-doc'],
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean' } } },
    async run() {
      return { ok: true, output: { written: true } }
    }
  }
  const ctx = (signal: AbortSignal): SkillToolContext => ({
    documentIds: [],
    readDocumentChunks: () => [],
    signal,
    audit: () => {}
  })
  const writeRunner = (confirmed: boolean): ToolRunner => async ({ signal }) => {
    const r = await runSkillTool(writeTool, { skillId: 's', input: {}, ctx: ctx(signal), confirmed })
    return { ok: r.ok, error: r.ok ? undefined : r.error }
  }

  it('a write tool run FAILS without confirmation (the gate refuses)', async () => {
    const c = new SkillRunController()
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'synthetic_write', documentCount: 0, runner: writeRunner(false) })
    expect(await waitForTerminal(c, runHandle)).toBe('failed')
    expect(c.get(runHandle)!.error).toMatch(/confirm/i)
  })

  it('a write tool run SUCCEEDS once confirmed (the modal path)', async () => {
    const c = new SkillRunController()
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'synthetic_write', documentCount: 0, runner: writeRunner(true) })
    expect(await waitForTerminal(c, runHandle)).toBe('done')
  })
})
