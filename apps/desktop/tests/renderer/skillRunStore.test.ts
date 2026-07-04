// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  startSkillRun,
  adoptSkillRuns,
  acknowledgeSkillRun,
  getSkillRunsSnapshot,
  subscribeSkillRuns,
  pickConversationRun,
  hasRunningRunElsewhere,
  getReattachConversationId,
  resetSkillRunStoreForTests,
  type SkillRunEntry
} from '../../src/renderer/lib/skillruns'
import type { SkillRunState } from '../../src/shared/types'

// SKA-6/SKA-17/SKA-39/SKA-40 (skills audit 2026-07-03, U6): the per-run store keyed by runHandle. It
// was a single module-level slot: a second run silently abandoned the first and the run bar rendered
// that one app-wide run in EVERY conversation. Now each run is a first-class entry carrying its
// {run, conversationId, documentId}; every live handle is polled independently; the store re-adopts
// main's runs on a fresh mount (a reload lost the module state) and tolerates transient poll errors.

const POLL_MS = 400

function mkRun(over: Partial<SkillRunState> = {}): SkillRunState {
  return {
    runHandle: 'h1',
    skillInstallId: 'app:bank-statement',
    toolName: 'extract_transactions',
    documentCount: 1,
    state: 'running',
    progress: { done: 0, total: 0 },
    conversationId: 'conv-1',
    documentId: 'doc-1',
    ...over
  }
}

type Api = Record<string, unknown>
function setApi(api: Api): void {
  ;(window as unknown as { api: Api }).api = api
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  resetSkillRunStoreForTests()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('skill-run store — per-run, conversation-keyed (SKA-6)', () => {
  it('tracks runs on two documents/conversations at once; each conversation sees only its own run', async () => {
    const runA = mkRun({ runHandle: 'hA', conversationId: 'convA', documentId: 'docA' })
    const runB = mkRun({ runHandle: 'hB', conversationId: 'convB', documentId: 'docB' })
    const states = new Map([
      ['hA', runA],
      ['hB', runB]
    ])
    setApi({
      startSkillRun: async (req: { documentId?: string }) => ({ started: true, run: req.documentId === 'docA' ? runA : runB }),
      getSkillRun: async (h: string) => states.get(h) ?? null
    })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'convA', documentId: 'docA' })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'convB', documentId: 'docB' })
    await vi.advanceTimersByTimeAsync(0)
    const snap = getSkillRunsSnapshot()
    expect(snap).toHaveLength(2) // the second run did NOT abandon the first
    // Each conversation's bar shows ONLY its own run — the SKA-6 core (no app-wide run in every chat).
    expect(pickConversationRun(snap, 'convA')?.run.runHandle).toBe('hA')
    expect(pickConversationRun(snap, 'convB')?.run.runHandle).toBe('hB')
    // A run in convA is never surfaced for convB (the wrong-transcript replay the audit describes).
    expect(pickConversationRun(snap, 'convB')?.run.runHandle).not.toBe('hA')
    expect(hasRunningRunElsewhere(snap, 'convA')).toBe(true)
    expect(hasRunningRunElsewhere(snap, 'convB')).toBe(true)
  })

  it('both runs reach a terminal outcome and are acknowledged independently (no lost outcome)', async () => {
    const clearSkillRun = vi.fn(async () => {})
    const a = mkRun({ runHandle: 'hA', conversationId: 'convA', documentId: 'docA' })
    const b = mkRun({ runHandle: 'hB', conversationId: 'convB', documentId: 'docB' })
    const states = new Map([
      ['hA', a],
      ['hB', b]
    ])
    setApi({
      startSkillRun: async (req: { documentId?: string }) => ({ started: true, run: req.documentId === 'docA' ? a : b }),
      getSkillRun: async (h: string) => states.get(h) ?? null,
      clearSkillRun
    })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'convA', documentId: 'docA' })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'convB', documentId: 'docB' })
    // Both finish.
    states.set('hA', mkRun({ runHandle: 'hA', state: 'done', count: 3, conversationId: 'convA', documentId: 'docA' }))
    states.set('hB', mkRun({ runHandle: 'hB', state: 'done', count: 7, conversationId: 'convB', documentId: 'docB' }))
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(pickConversationRun(getSkillRunsSnapshot(), 'convA')?.run.count).toBe(3)
    expect(pickConversationRun(getSkillRunsSnapshot(), 'convB')?.run.count).toBe(7)
    // Acknowledging one leaves the other's outcome intact + acknowledgeable.
    acknowledgeSkillRun('hA')
    expect(clearSkillRun).toHaveBeenCalledWith('hA')
    expect(getSkillRunsSnapshot().map((e) => e.run.runHandle)).toEqual(['hB'])
    acknowledgeSkillRun('hB')
    expect(getSkillRunsSnapshot()).toHaveLength(0)
  })

  it('acknowledge is a no-op on a still-running run', async () => {
    const run = mkRun()
    setApi({ startSkillRun: async () => ({ started: true, run }), getSkillRun: async () => run })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'conv-1', documentId: 'doc-1' })
    acknowledgeSkillRun('h1')
    expect(getSkillRunsSnapshot()).toHaveLength(1) // running → not dropped
  })
})

describe('skill-run store — poll resilience (SKA-39/40)', () => {
  it('does NOT re-notify on an identical poll (SKA-39 shallow-compare)', async () => {
    const running = mkRun()
    setApi({
      startSkillRun: async () => ({ started: true, run: running }),
      getSkillRun: async () => ({ ...running, progress: { ...running.progress } }) // a fresh object, identical fields
    })
    const listener = vi.fn()
    subscribeSkillRuns(listener)
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'conv-1', documentId: 'doc-1' })
    await vi.advanceTimersByTimeAsync(0) // settle the immediate refresh poll (identical → no notify)
    const after = listener.mock.calls.length // one notify from adopt
    await vi.advanceTimersByTimeAsync(POLL_MS * 3) // three identical poll ticks
    expect(listener.mock.calls.length).toBe(after) // no re-render churn
  })

  it('tolerates transient poll errors, then keeps a labelled "state unknown" row (SKA-40)', async () => {
    const running = mkRun()
    setApi({
      startSkillRun: async () => ({ started: true, run: running }),
      getSkillRun: async () => {
        throw new Error('transient IPC error')
      }
    })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'conv-1', documentId: 'doc-1' })
    // immediate poll (#1) + two interval ticks (#2, #3) = MAX_POLL_FAILURES → give up, keep the row.
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    const snap = getSkillRunsSnapshot()
    expect(snap).toHaveLength(1) // NOT silently dropped (today one error orphaned it)
    expect(snap[0].stateUnknown).toBe(true)
    // Give-up stops polling: no further churn, and the row stays acknowledgeable.
    const before = getSkillRunsSnapshot()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(getSkillRunsSnapshot()).toBe(before)
    acknowledgeSkillRun('h1') // a state-unknown row is dismissable
    expect(getSkillRunsSnapshot()).toHaveLength(0)
  })

  it('marks a running run "state unknown" (dismissable) when a poll returns null — never a stuck bar', async () => {
    const cur = { run: mkRun() as SkillRunState | null }
    setApi({
      startSkillRun: async () => ({ started: true, run: cur.run }),
      getSkillRun: async () => cur.run
    })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'conv-1', documentId: 'doc-1' })
    // Main loses the run (a swept slot / main restart): getSkillRun returns null for the LIVE handle.
    cur.run = null
    await vi.advanceTimersByTimeAsync(POLL_MS)
    const snap = getSkillRunsSnapshot()
    expect(snap).toHaveLength(1) // kept, not dropped
    expect(snap[0].stateUnknown).toBe(true) // so the row is dismissable (a running row's Cancel is dead)
    acknowledgeSkillRun('h1')
    expect(getSkillRunsSnapshot()).toHaveLength(0)
  })

  it('a running run that polls to done stops its timer (no further polls after terminal)', async () => {
    let calls = 0
    const cur = { run: mkRun() }
    setApi({
      startSkillRun: async () => ({ started: true, run: cur.run }),
      getSkillRun: async () => {
        calls++
        return cur.run
      }
    })
    await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'conv-1', documentId: 'doc-1' })
    cur.run = mkRun({ state: 'done', count: 2 })
    await vi.advanceTimersByTimeAsync(POLL_MS) // one tick observes 'done' → stop
    const callsAtDone = calls
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(calls).toBe(callsAtDone) // polling stopped at terminal
    expect(getSkillRunsSnapshot()[0].run.state).toBe('done')
  })
})

describe('skill-run store — reload re-attach (SKA-17)', () => {
  it('re-adopts every run on a fresh mount — live AND terminal-unacknowledged', async () => {
    const live = mkRun({ runHandle: 'hL', state: 'running', conversationId: 'convL', documentId: 'docL' })
    const term = mkRun({ runHandle: 'hT', state: 'done', count: 5, conversationId: 'convT', documentId: 'docT' })
    const states = new Map([
      ['hL', live],
      ['hT', term]
    ])
    setApi({
      listSkillRuns: async () => [live, term],
      getSkillRun: async (h: string) => states.get(h) ?? null
    })
    await adoptSkillRuns()
    await vi.advanceTimersByTimeAsync(0)
    const snap = getSkillRunsSnapshot()
    expect(snap.map((e) => e.run.runHandle).sort()).toEqual(['hL', 'hT'])
    // The terminal run's outcome is finally shown/acknowledgeable after a reload.
    expect(pickConversationRun(snap, 'convT')?.run.count).toBe(5)
    // The mount lands the user back on the RUNNING run's conversation.
    expect(getReattachConversationId()).toBe('convL')
  })

  it('is idempotent — a second adopt does not duplicate an already-tracked run', async () => {
    const live = mkRun({ runHandle: 'hL', state: 'running', conversationId: 'convL', documentId: 'docL' })
    setApi({ listSkillRuns: async () => [live], getSkillRun: async () => live })
    await adoptSkillRuns()
    await adoptSkillRuns()
    await vi.advanceTimersByTimeAsync(0)
    expect(getSkillRunsSnapshot()).toHaveLength(1)
  })

  it('re-adopts an orphaned run from a BUSY refusal that carries the running handle', async () => {
    const orphan = mkRun({ runHandle: 'hO', state: 'running', conversationId: 'convO', documentId: 'docO' })
    setApi({
      startSkillRun: async () => ({ started: false, error: 'busy', runningHandle: 'hO' }),
      getSkillRun: async (h: string) => (h === 'hO' ? orphan : null)
    })
    const outcome = await startSkillRun({
      skillInstallId: 'app:bank-statement',
      toolName: 'extract_transactions',
      conversationId: 'convX',
      documentId: 'docO'
    })
    expect(outcome).toEqual({ started: false, error: 'busy' })
    await vi.advanceTimersByTimeAsync(0) // let the fallback re-attach poll settle
    const snap = getSkillRunsSnapshot()
    expect(snap.map((e) => e.run.runHandle)).toContain('hO')
    // The re-adopted run learns its own conversation from the polled state (survives a reset store).
    expect(pickConversationRun(snap, 'convO')?.run.runHandle).toBe('hO')
  })
})

describe('skill-run store — pure selectors', () => {
  const entry = (over: {
    run?: Partial<SkillRunState>
    conversationId?: string
    documentId?: string | null
    stateUnknown?: boolean
  }): SkillRunEntry => ({
    run: mkRun(over.run),
    conversationId: over.conversationId ?? 'c',
    documentId: over.documentId ?? 'd',
    stateUnknown: over.stateUnknown ?? false
  })

  it('pickConversationRun returns the MOST RECENT entry for the conversation', () => {
    const runs = [
      entry({ run: { runHandle: 'old' }, conversationId: 'c1' }),
      entry({ run: { runHandle: 'other' }, conversationId: 'c2' }),
      entry({ run: { runHandle: 'new' }, conversationId: 'c1' })
    ]
    expect(pickConversationRun(runs, 'c1')?.run.runHandle).toBe('new')
    expect(pickConversationRun(runs, 'c2')?.run.runHandle).toBe('other')
    expect(pickConversationRun(runs, 'c3')).toBeNull()
    expect(pickConversationRun(runs, null)).toBeNull()
  })

  it('hasRunningRunElsewhere ignores the active conversation and terminal runs', () => {
    const runs = [
      entry({ run: { runHandle: 'a', state: 'running' }, conversationId: 'c1' }),
      entry({ run: { runHandle: 'b', state: 'done' }, conversationId: 'c2' })
    ]
    expect(hasRunningRunElsewhere(runs, 'c1')).toBe(false) // only c1 runs (the active one) + a done c2
    expect(hasRunningRunElsewhere(runs, 'c2')).toBe(true) // c1 is running elsewhere
  })
})
