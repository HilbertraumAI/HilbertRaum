import { describe, it, expect, vi, afterEach } from 'vitest'
import { LocalApiAdmission, type Admission, type LocalApiAdmissionDeps } from '../../src/main/services/local-api/admission'
import { RuntimeManager } from '../../src/main/services/runtime'

// Admission unit tests (local-api P1). The module guards the single external slot in
// front of the RuntimeManager generation gate: fail-closed on no runtime (covers the
// start window incl. the #109 warm-up, which generates while active() is null), shallow
// 0–1 queue, in-app pre-emption cancels the active stream AND the parked waiter, and the
// lock/teardown latch refuses admission outright.

afterEach(() => {
  vi.useRealTimers()
})

function makeDeps(overrides: Partial<LocalApiAdmissionDeps> = {}): LocalApiAdmissionDeps {
  return {
    isGenerating: () => false,
    hasActiveRuntime: () => true,
    hasActiveDocTask: () => false,
    admitsWork: () => true,
    ...overrides
  }
}

function admitted(outcome: ReturnType<LocalApiAdmission['tryAdmit']>): Admission {
  expect(outcome).not.toBe('busy')
  expect(outcome).not.toBe('locked')
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
    // Back isGenerating() with a REAL manager gate and drive a generation the way the
    // benchmark / a skill run does: straight through active().chatStream, registered
    // nowhere. The gate still counts it, so admission refuses.
    const mgr = new RuntimeManager((opts) => ({
      modelId: opts.modelId,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: '', port: null }),
      chatStream: async function* (): AsyncGenerator<string, void, unknown> {
        yield 'tok'
        await new Promise<void>(() => {}) // holds the lane until the consumer walks away
      }
    }))
    await mgr.start({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 2048 })
    const admission = new LocalApiAdmission(
      makeDeps({
        isGenerating: () => mgr.isGenerating(),
        hasActiveRuntime: () => mgr.active() != null
      })
    )
    const direct = mgr.active()!.chatStream([{ role: 'user', content: 'benchmark-style' }])
    await direct.next() // the lane is live
    expect(admission.tryAdmit('r1')).toBe('busy')
    await direct.return()
    admitted(admission.tryAdmit('r2')).release()
  })

  it('FAILS CLOSED: no active runtime (start window / #109 warm-up) refuses admission', () => {
    const admission = new LocalApiAdmission(makeDeps({ hasActiveRuntime: () => false }))
    expect(admission.tryAdmit('r1')).toBe('busy')
  })

  it('refuses while a doc task is active', () => {
    const admission = new LocalApiAdmission(makeDeps({ hasActiveDocTask: () => true }))
    expect(admission.tryAdmit('r1')).toBe('busy')
  })

  it('pre-emption aborts the ACTIVE stream signal and cancels the parked waiter', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2')) // admitted-but-unstarted (the TOCTOU class)
    admission.preemptExternal('in-app generation entered')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    await expect(b.ready).resolves.toBe(false) // the waiter never starts into the in-app turn
    a.release()
    // After the in-app turn (deps idle again here), the slot works again.
    admitted(admission.tryAdmit('r3')).release()
  })

  it('teardown (abortAll) aborts active + queued', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    admission.abortAll('server stopping')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    await expect(b.ready).resolves.toBe(false)
  })

  it('a queued waiter is promoted to FALSE when the world changed (in-app started meanwhile)', async () => {
    let generating = false
    const admission = new LocalApiAdmission(makeDeps({ isGenerating: () => generating }))
    const a = admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    generating = true // an in-app turn began before the release
    a.release()
    // Honest fast refusal (429 + Retry-After at the HTTP layer), never a silent hang.
    await expect(b.ready).resolves.toBe(false)
  })

  it('caps the queued wait (default 30 s) and answers false', async () => {
    vi.useFakeTimers()
    const admission = new LocalApiAdmission(makeDeps())
    admitted(admission.tryAdmit('r1'))
    const b = admitted(admission.tryAdmit('r2'))
    const ready = b.ready
    vi.advanceTimersByTime(30_000)
    await expect(ready).resolves.toBe(false)
    // The queue slot is free again for a fresh waiter.
    admitted(admission.tryAdmit('r3'))
  })

  it('a caller disconnect frees the queue slot immediately', async () => {
    const admission = new LocalApiAdmission(makeDeps())
    admitted(admission.tryAdmit('r1'))
    const caller = new AbortController()
    const b = admitted(admission.tryAdmit('r2', caller.signal))
    caller.abort()
    await expect(b.ready).resolves.toBe(false)
    // The vacated queue slot admits a new waiter (not 'busy').
    admitted(admission.tryAdmit('r3'))
  })

  it('an already-aborted caller signal is never admitted', () => {
    const admission = new LocalApiAdmission(makeDeps())
    const caller = new AbortController()
    caller.abort()
    expect(admission.tryAdmit('r1', caller.signal)).toBe('busy')
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
    // Wire admission ↔ gate exactly as the local API will: the manager's pre-emption hook
    // aborts admission's signals; the gate awaits the external stream's real teardown.
    const sources: Array<{ push: (v: string) => void; end: () => void }> = []
    const mgr = new RuntimeManager((opts) => ({
      modelId: opts.modelId,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: '', port: null }),
      chatStream(_m, options) {
        const queue: string[] = []
        let ended = false
        let wake: (() => void) | null = null
        sources.push({
          push: (v) => {
            queue.push(v)
            wake?.()
          },
          end: () => {
            ended = true
            wake?.()
          }
        })
        const signal = options?.signal
        return (async function* (): AsyncGenerator<string, void, unknown> {
          for (;;) {
            if (signal?.aborted) return
            if (queue.length > 0) {
              yield queue.shift()!
              continue
            }
            if (ended) return
            await new Promise<void>((resolve) => {
              wake = resolve
              signal?.addEventListener('abort', () => resolve(), { once: true })
            })
          }
        })()
      }
    }))
    await mgr.start({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 2048 })
    const admission = new LocalApiAdmission(
      makeDeps({
        isGenerating: () => mgr.isGenerating(),
        hasActiveRuntime: () => mgr.active() != null
      })
    )
    mgr.setExternalPreemption((reason) => admission.preemptExternal(reason))

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
      // The external consumer loop: drains until the abort ends the stream, then releases.
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
  })
})
