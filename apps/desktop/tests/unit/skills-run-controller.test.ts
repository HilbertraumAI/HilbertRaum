import { describe, it, expect } from 'vitest'
import { SkillRunController, type ToolRunner } from '../../src/main/services/skills/run-controller'
import { runSkillTool } from '../../src/main/services/skills/tool-registry'
import type { SkillTool, SkillToolContext } from '../../src/shared/types'

// architecture.md "Skills — design record" §9 (S11b) — the GENERIC tool-run lifecycle controller: running →
// terminal, progress merge, Cancel via the AbortSignal, the write/export CONFIRM gate, and (A2, audit
// §6.2) PER-DOCUMENT concurrency: "a skill is already working" fires only for the same document, so two
// documents run in parallel. Also pins the generic `count` outcome field (+ its deprecated
// `transactionCount` alias).

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
  it('runs to done, merges progress, and reports the count (generic `count`, alias mirrored)', async () => {
    const c = new SkillRunController()
    const runner: ToolRunner = async ({ onProgress }) => {
      onProgress({ done: 1, total: 2 })
      return { ok: true, count: 7 }
    }
    const initial = c.start({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    expect(initial.state).toBe('running')
    expect(c.isRunning()).toBe(true)
    expect(await waitForTerminal(c, initial.runHandle)).toBe('done')
    const final = c.get(initial.runHandle)!
    expect(final.count).toBe(7)
    expect(final.transactionCount).toBe(7) // the deprecated alias is mirrored for one release
    expect(final.progress).toEqual({ done: 1, total: 2 })
    expect(c.isRunning()).toBe(false)
  })

  it('accepts a runner still emitting the deprecated `transactionCount` (read via `count ?? transactionCount`)', async () => {
    const c = new SkillRunController()
    const runner: ToolRunner = async () => ({ ok: true, transactionCount: 5 }) // legacy producer
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    expect(await waitForTerminal(c, runHandle)).toBe('done')
    expect(c.get(runHandle)!.count).toBe(5) // resolved from the alias
    expect(c.get(runHandle)!.transactionCount).toBe(5)
  })

  it('cancel aborts the run and marks it cancelled (no done)', async () => {
    const c = new SkillRunController()
    const runner: ToolRunner = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false }))
      })
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    c.cancel(runHandle)
    expect(await waitForTerminal(c, runHandle)).toBe('cancelled')
  })

  it('a seam-reported cancel (no signal abort) is shown as cancelled, not failed (B1)', async () => {
    // The CSV save-dialog dismissal: the run did not abort, but the seam reports it cancelled.
    const c = new SkillRunController()
    const runner: ToolRunner = async () => ({ ok: false, cancelled: true, error: 'Export cancelled. Nothing was saved.' })
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'export_transactions_csv', documentId: 'doc-a', documentCount: 1, runner })
    expect(await waitForTerminal(c, runHandle)).toBe('cancelled')
    expect(c.get(runHandle)!.error).toBeUndefined() // a calm cancel carries no failure copy
  })

  it('a successful outcome is done even if Cancel landed late (B2 — no false "cancelled")', async () => {
    // The work persisted before the abort was observed: the controller must not claim "cancelled".
    const c = new SkillRunController()
    const runner: ToolRunner = ({ signal }) =>
      new Promise((resolve) => {
        // Abort AFTER the work has already succeeded — the seam still reports ok (it committed).
        signal.addEventListener('abort', () => resolve({ ok: true, count: 3 }))
      })
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    c.cancel(runHandle)
    expect(await waitForTerminal(c, runHandle)).toBe('done')
    expect(c.get(runHandle)!.count).toBe(3)
  })

  it('refuses a second run on the SAME document while one is in flight (per-document one-at-a-time)', () => {
    const c = new SkillRunController()
    const runner: ToolRunner = ({ signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false })))
    c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    expect(() =>
      c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    ).toThrow()
  })

  it('allows concurrent runs on DIFFERENT documents (audit §6.2 — no app-wide serialization)', async () => {
    // The regression this fixes: one app-wide active run made "A skill is already working" fire across
    // unrelated conversations/documents. Two documents must now run in parallel.
    const c = new SkillRunController()
    const runner = (): ToolRunner =>
      ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false })))
    const a = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner: runner() })
    // A second document does NOT throw — it starts alongside the first.
    const b = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-b', documentCount: 1, runner: runner() })
    expect(c.get(a.runHandle)!.state).toBe('running')
    expect(c.get(b.runHandle)!.state).toBe('running')
    expect(c.isRunning('doc-a')).toBe(true)
    expect(c.isRunning('doc-b')).toBe(true)
    // Cancelling one leaves the other running (per-document isolation).
    c.cancel(a.runHandle)
    expect(await waitForTerminal(c, a.runHandle)).toBe('cancelled')
    expect(c.get(b.runHandle)!.state).toBe('running')
    expect(c.isRunning('doc-b')).toBe(true)
    c.cancel(b.runHandle)
    expect(await waitForTerminal(c, b.runHandle)).toBe('cancelled')
  })

  it('a same-document run can start again once the prior terminal run is cleared', async () => {
    const c = new SkillRunController()
    const first = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner: async () => ({ ok: true, count: 1 }) })
    await waitForTerminal(c, first.runHandle)
    c.clear(first.runHandle)
    // The slot is free; a new run on the same document starts without throwing.
    const second = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner: async () => ({ ok: true, count: 2 }) })
    expect(await waitForTerminal(c, second.runHandle)).toBe('done')
    expect(c.get(first.runHandle)).toBeNull() // the cleared run is gone
  })

  it('clear() drops a terminal run so the next can start', async () => {
    const c = new SkillRunController()
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner: async () => ({ ok: true }) })
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
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'synthetic_write', documentId: 'doc-w', documentCount: 0, runner: writeRunner(false) })
    expect(await waitForTerminal(c, runHandle)).toBe('failed')
    expect(c.get(runHandle)!.error).toMatch(/confirm/i)
  })

  it('a write tool run SUCCEEDS once confirmed (the modal path)', async () => {
    const c = new SkillRunController()
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'synthetic_write', documentId: 'doc-w', documentCount: 0, runner: writeRunner(true) })
    expect(await waitForTerminal(c, runHandle)).toBe('done')
  })
})
