import { describe, it, expect, vi } from 'vitest'
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

  // T2 (skills-audit-2026-07-03 §3.3 run-lifecycle gaps) — the two previously-untested finish() paths.
  it('a runner whose promise REJECTS is mapped to failed by the .catch → finish({ok:false}) path (T2)', async () => {
    // The seam normally resolves a failure envelope; an UNEXPECTED throw (a bug past the seam's own B4
    // guards) must still terminate the run — never leave the renderer polling 'running' forever.
    // Teeth: drop the `.catch(...)` in start() → the run never goes terminal → waitForTerminal throws.
    const c = new SkillRunController()
    const runner: ToolRunner = async () => {
      throw new Error('seam blew up unexpectedly')
    }
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    expect(await waitForTerminal(c, runHandle)).toBe('failed')
    // The thrown error's text never crosses (content-free posture) — the fixed friendly copy stands in.
    const final = c.get(runHandle)!
    expect(final.error).toBe('This tool could not finish. Nothing was changed.')
    expect(final.error).not.toContain('seam blew up')
  })

  it('a runner that THROWS after abort (no cancelled flag) is cancelled via the signal.aborted fallback, not failed (T2)', async () => {
    // A cancel that lands mid-work can surface as a REJECTION (an aborted fetch/write throwing) rather
    // than a calm `{ok:false, cancelled:true}` envelope. The .catch has no outcome flag to read, so
    // finish() must fall back to `controller.signal.aborted` — the user pressed Cancel and must see
    // "cancelled", never a red "failed". Teeth: drop the `|| controller.signal.aborted` fallback in
    // finish() → this reds with state 'failed'.
    const c = new SkillRunController()
    const runner: ToolRunner = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('interrupted mid-write')))
      })
    const { runHandle } = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner })
    c.cancel(runHandle)
    expect(await waitForTerminal(c, runHandle)).toBe('cancelled')
    expect(c.get(runHandle)!.error).toBeUndefined() // a calm cancel carries no failure copy
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

// SKA-6/SKA-17 (skills audit 2026-07-03, U6): the controller now carries the launching conversation on
// its content-free run state, lists every run for a renderer reload to re-adopt, surfaces a busy run's
// handle by document, and TTL-sweeps a never-acknowledged terminal run so the Map stays bounded.
describe('SkillRunController — re-attach surface (U6)', () => {
  const idle = (): ToolRunner => ({ signal }) =>
    new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false })))

  it('threads conversationId onto the content-free run state (SKA-6/SKA-17)', () => {
    const c = new SkillRunController()
    const s = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, conversationId: 'conv-1', runner: idle() })
    expect(s.conversationId).toBe('conv-1')
    expect(s.documentId).toBe('doc-a')
    expect(c.get(s.runHandle)!.conversationId).toBe('conv-1')
  })

  it('list() returns every run — running AND terminal-but-unacknowledged (SKA-17 re-adopt)', async () => {
    const c = new SkillRunController()
    const live = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, conversationId: 'conv-a', runner: idle() })
    const done = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-b', documentCount: 1, conversationId: 'conv-b', runner: async () => ({ ok: true, count: 2 }) })
    expect(await waitForTerminal(c, done.runHandle)).toBe('done')
    const all = c.list()
    expect(all.map((r) => r.runHandle).sort()).toEqual([live.runHandle, done.runHandle].sort())
    // The terminal run kept its count + conversationId so the reloaded renderer shows the outcome.
    const terminal = all.find((r) => r.runHandle === done.runHandle)!
    expect(terminal.state).toBe('done')
    expect(terminal.count).toBe(2)
    expect(terminal.conversationId).toBe('conv-b')
    c.cancel(live.runHandle)
  })

  it('getByDocument() surfaces a running run so a busy refusal can carry its handle (SKA-17)', () => {
    const c = new SkillRunController()
    const s = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, conversationId: 'conv-a', runner: idle() })
    expect(c.getByDocument('doc-a')!.runHandle).toBe(s.runHandle)
    expect(c.getByDocument('doc-none')).toBeNull()
    c.cancel(s.runHandle)
  })

  it('TTL-sweeps a never-acknowledged terminal run on the next start() (SKA-17 — bounded Map)', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    const c = new SkillRunController()
    const first = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-a', documentCount: 1, runner: async () => ({ ok: true, count: 1 }) })
    expect(await waitForTerminal(c, first.runHandle)).toBe('done')
    expect(c.get(first.runHandle)).not.toBeNull() // retained within the TTL (a quick reload re-adopts it)
    // Advance well past the 30-minute TTL; the next start() sweeps the stale terminal entry.
    now.mockReturnValue(1_000 + 31 * 60 * 1000)
    const second = c.start({ skillInstallId: 's', toolName: 'extract_transactions', documentId: 'doc-b', documentCount: 1, runner: async () => ({ ok: true }) })
    expect(c.get(first.runHandle)).toBeNull() // swept
    expect(c.list().map((r) => r.runHandle)).toContain(second.runHandle)
    now.mockRestore()
  })
})
