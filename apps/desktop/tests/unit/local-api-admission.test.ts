import { describe, it, expect, vi, afterEach } from 'vitest'
import { LocalApiAdmission, type Admission, type LocalApiAdmissionDeps } from '../../src/main/services/local-api/admission'
import { RuntimeManager } from '../../src/main/services/runtime'
import { manualSource, type ManualSource } from '../helpers/manual-stream'

// Admission unit tests (local-api P1). The module guards the single external slot in
// front of the RuntimeManager generation gate: fail-closed via the manager-owned
// `isExternallyBusy` predicate (covers the start window incl. the #109 warm-up, which
// generates while active() is null), shallow 0–1 queue, in-app pre-emption/teardown via
// `abortAll` (cancels the active stream AND the parked waiter), and the lock latch
// refusing admission outright. Invariant pinned throughout: ready:false ⇒ signal aborted.

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

describe('LocalApiAdmission', () => {
  it('admits one request when idle; ready resolves true immediately', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    const a = admitted(admission.tryAdmit('r1'))
    await expect(a.ready).resolves.toBe(true)
    expect(a.signal.aborted).toBe(false)
    a.release()
  })

  it('serial admission: second request queues (depth 1), third is refused outright', () => {
    const admission = new LocalApiAdmission(makeDeps())
    admitted(admission.tryAdmit('r1'))
    admitted(admission.tryAdmit('r2')) // the single queued waiter
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

  it('refuses while the lock/teardown latch is armed (AUD-02 class: never admit mid-teardown)', () => {
    const admission = new LocalApiAdmission(makeDeps({ admitsWork: () => false }))
    expect(admission.tryAdmit('r1')).toBe('locked')
  })

  it('refuses while ANY generation lane is active — incl. a direct chatStream call no registry sees', async () => {
    // Back runtimeBusy with a REAL manager and drive a generation the way the benchmark /
    // a skill run does: straight through active().chatStream, registered nowhere. The
    // gate still counts it, so admission refuses.
    const sources: ManualSource[] = []
    const mgr = new RuntimeManager((opts) => ({
      modelId: opts.modelId,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: '', port: null }),
      chatStream(_m, options) {
        const src = manualSource()
        sources.push(src)
        return src.stream(options?.signal)
      }
    }))
    await mgr.start({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 2048 })
    const admission = new LocalApiAdmission(makeDeps({ runtimeBusy: () => mgr.isExternallyBusy() }))
    const direct = mgr.active()!.chatStream([{ role: 'user', content: 'benchmark-style' }])
    const pull = direct.next()
    await Promise.resolve()
    sources[0].push('tok')
    await pull // the lane is live
    expect(admission.tryAdmit('r1')).toBe('busy')
    sources[0].end()
    await direct.return()
    admitted(admission.tryAdmit('r2')).release()
    await mgr.stop()
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

  it('refuses while a doc task is active', () => {
    const admission = new LocalApiAdmission(makeDeps({ hasActiveDocTask: () => true }))
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

  it('caps the queued wait (default 30 s): ready false, signal aborted, queue slot freed', async () => {
    vi.useFakeTimers()
    const admission = new LocalApiAdmission(makeDeps())
    admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    vi.advanceTimersByTime(30_000)
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
    let bSettled: boolean | null = null
    void b.ready.then((v) => (bSettled = v))
    await Promise.resolve()
    expect(bSettled).toBeNull()
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
    b.release()
    b.release()
    admitted(admission.tryAdmit('r3')).release()
  })

  it('END-TO-END with the manager gate: in-app entry pre-empts the admitted external stream', async () => {
    // Wire admission ↔ gate exactly as the local API will: the manager's pre-emption
    // hook calls abortAll; the gate awaits the external stream's real teardown.
    const sources: ManualSource[] = []
    const mgr = new RuntimeManager((opts) => ({
      modelId: opts.modelId,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: '', port: null }),
      chatStream(_m, options) {
        const src = manualSource()
        sources.push(src)
        return src.stream(options?.signal)
      }
    }))
    await mgr.start({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 2048 })
    const admission = new LocalApiAdmission(makeDeps({ runtimeBusy: () => mgr.isExternallyBusy() }))
    mgr.setExternalPreemption((reason) => admission.abortAll(reason))

    // External request: admitted, streaming.
    const adm = admitted(admission.tryAdmit('ext-1'))
    await expect(adm.ready).resolves.toBe(true)
    const external = mgr.active()!.chatStream([{ role: 'user', content: 'x' }], {
      lane: 'external',
      signal: adm.signal
    })
    const extFirst = external.next()
    await Promise.resolve()
    sources[0].push('e1')
    expect((await extFirst).value).toBe('e1')

    // In-app turn enters: hook aborts the external signal; the gate awaits teardown.
    const externalRun = (async () => {
      // The external consumer contract: drain until the abort ends the stream, THEN release.
      for (;;) {
        const r = await external.next()
        if (r.done) break
      }
      adm.release()
    })()
    const inApp = mgr.active()!.chatStream([{ role: 'user', content: 'q' }])
    const inAppFirst = inApp.next()
    await externalRun // settles only because pre-emption aborted the external stream
    expect(adm.signal.aborted).toBe(true)
    sources[1].push('a1')
    expect((await inAppFirst).value).toBe('a1')
    await inApp.return()
    mgr.setExternalPreemption(null)
    await mgr.stop()
  })
})
