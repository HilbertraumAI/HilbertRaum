import { describe, it, expect, vi, afterEach } from 'vitest'
import { LocalApiAdmission, type Admission, type LocalApiAdmissionDeps } from '../../src/main/services/local-api/admission'
import { RuntimeManager } from '../../src/main/services/runtime'

// Admission unit tests (local-api P1). The module guards the single external slot in
// front of the RuntimeManager generation gate: fail-closed via the manager-owned
// `isExternallyBusy` predicate (covers the start window incl. the #109 warm-up, which
// generates while active() is null), shallow 0–1 queue, in-app pre-emption/teardown via
// `abortAll` (cancels the active stream AND the parked waiter), and the lock latch.
// Invariant pinned throughout: ready:false ⇒ signal aborted. The refusals that have an HTTP
// answer (busy on any lane, a doc task, a locked workspace) and the real pre-emption wiring
// are proved over HTTP in local-api-server.test.ts; this file keeps the state machine the
// server cannot reach (vault + local API test campaign, 2026-11-16).

afterEach(() => {
  vi.useRealTimers()
})

function makeDeps(overrides: Partial<LocalApiAdmissionDeps> = {}): LocalApiAdmissionDeps {
  return {
    runtimeBusy: () => false,
    hasActiveDocTask: () => false,
    admitsWork: () => true,
    ...overrides
  }
}

function admitted(outcome: ReturnType<LocalApiAdmission['tryAdmit']>): Admission {
  expect(typeof outcome).not.toBe('string')
  return outcome as Admission
}

/** What `ready` has settled to one microtask from now, or null while the waiter is still parked. */
async function settledYet(ready: Promise<boolean>): Promise<boolean | null> {
  let value: boolean | null = null
  void ready.then((v) => (value = v))
  await Promise.resolve()
  return value
}

describe('LocalApiAdmission', () => {
  it('serial admission: second request queues (depth 1), third is refused outright', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    admitted(admission.tryAdmit('r1'))
    const r2 = admitted(admission.tryAdmit('r2')) // the single queued waiter
    expect(await settledYet(r2.ready)).toBeNull() // parked, not a second holder of the slot
    expect(admission.tryAdmit('r3')).toBe('busy') // beyond the shallow queue → fast 429
  })

  it('the queued waiter is promoted when the active request releases', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    a.release()
    await expect(b.ready).resolves.toBe(true)
    b.release()
    // Slot fully free again.
    const c = admitted(admission.tryAdmit('r3'))
    await expect(c.ready).resolves.toBe(true)
    c.release()
  })

  // AUD-02 at promotion: the entry check (`tryAdmit` → 'locked') is local-api-server's "locked workspace → 503
  // workspace_locked"; a waiter parked BEFORE the lock latch armed is only stopped by the re-check at promotion.
  it('a queued waiter promoted after the lock latch armed is refused, not admitted mid-teardown (AUD-02)', async () => {
    let admits = true
    const admission = new LocalApiAdmission(makeDeps({ admitsWork: () => admits }))
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    admits = false // the lock (or quit) teardown began while b waited
    a.release()
    await expect(b.ready).resolves.toBe(false)
    expect(b.signal.aborted).toBe(true) // ready:false ⇒ aborted invariant
  })

  it('FAILS CLOSED: no active runtime (start window / #109 warm-up) refuses admission', () => {
    // A fresh manager that never started anything: isExternallyBusy() is true.
    const mgr = new RuntimeManager(() => {
      throw new Error('factory must not run in this test')
    })
    const admission = new LocalApiAdmission(makeDeps({ runtimeBusy: () => mgr.isExternallyBusy() }))
    expect(mgr.isExternallyBusy()).toBe(true)
    expect(admission.tryAdmit('r1')).toBe('busy')
  })

  it('abortAll aborts the ACTIVE stream signal and cancels the parked waiter (pre-emption + teardown)', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2')) // admitted-but-unstarted (the TOCTOU class)
    admission.abortAll('in-app generation entered')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    await expect(b.ready).resolves.toBe(false) // the waiter never starts into the in-app turn
    a.release()
    // After the in-app turn (deps idle again here), the slot works again.
    admitted(admission.tryAdmit('r3')).release()
  })

  it('a queued waiter is refused (ready false + aborted signal) when the world changed at promotion', async () => {
    let busy = false
    const admission = new LocalApiAdmission(makeDeps({ runtimeBusy: () => busy }))
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    busy = true // an in-app turn began before the release
    a.release()
    // Honest fast refusal (429 + Retry-After at the HTTP layer), never a silent hang.
    await expect(b.ready).resolves.toBe(false)
    expect(b.signal.aborted).toBe(true) // ready:false ⇒ aborted invariant
  })

  it('caps the queued wait (30 s, docs/local-api.md §6.7): ready false, signal aborted, queue slot freed', async () => {
    vi.useFakeTimers()
    const admission = new LocalApiAdmission(makeDeps())
    admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    vi.advanceTimersByTime(29_999) // just short of the shipped bound: still waiting
    expect(await settledYet(b.ready)).toBeNull()
    expect(b.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(b.ready).resolves.toBe(false)
    expect(b.signal.aborted).toBe(true)
    // The queue slot is free again for a fresh waiter.
    admitted(admission.tryAdmit('r3'))
  })

  it('a QUEUED caller disconnect frees the queue slot immediately', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    admitted(admission.tryAdmit('r1'))
    const caller = new AbortController()
    const b = admitted(admission.tryAdmit('r2', caller.signal))
    caller.abort()
    await expect(b.ready).resolves.toBe(false)
    expect(b.signal.aborted).toBe(true)
    // The vacated queue slot admits a new waiter (not 'busy').
    admitted(admission.tryAdmit('r3'))
  })

  it('an ACTIVE caller disconnect does NOT release in the abort frame — the holder releases after teardown and the waiter is PROMOTED', async () => {
    // The promotion-race fix (review 2026-08-18): releasing inside the abort frame ran
    // the promotion re-check while the dying stream still counted as busy, refusing the
    // patient waiter spuriously. The slot must stay with its holder until real teardown.
    let busy = false
    const admission = new LocalApiAdmission(makeDeps({ runtimeBusy: () => busy }))
    const caller = new AbortController()
    const a = admitted(admission.tryAdmit('r1', caller.signal))
    busy = true // a's stream is now counted by the gate
    const b = admitted(admission.tryAdmit('r2'))
    caller.abort() // client vanishes mid-stream — the stream is still draining
    expect(a.signal.aborted).toBe(true)
    // No promotion yet — b still parked (would have been refused under the old code).
    expect(await settledYet(b.ready)).toBeNull()
    // The holder's stream tears down, the gate count drops, THEN the holder releases.
    busy = false
    a.release()
    await expect(b.ready).resolves.toBe(true)
    b.release()
  })

  it("an already-aborted caller is 'aborted', never 'busy' (no phantom contention accounting)", () => {
    const admission = new LocalApiAdmission(makeDeps())
    const caller = new AbortController()
    caller.abort()
    expect(admission.tryAdmit('r1', caller.signal)).toBe('aborted')
  })

  it('release is idempotent and never double-promotes', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    a.release()
    a.release()
    await expect(b.ready).resolves.toBe(true)
    // b holds the slot: the second release of a vacated nothing, so the next caller parks and the one after is refused.
    const c = admitted(admission.tryAdmit('r3'))
    expect(await settledYet(c.ready)).toBeNull()
    expect(admission.tryAdmit('r4')).toBe('busy')
    b.release()
    b.release()
    await expect(c.ready).resolves.toBe(true)
    const d = admitted(admission.tryAdmit('r5'))
    expect(await settledYet(d.ready)).toBeNull() // c holds it now: promoted once, not freed twice
    c.release()
    await expect(d.ready).resolves.toBe(true)
    d.release()
  })
})
