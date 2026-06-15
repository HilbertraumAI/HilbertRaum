import { describe, it, expect } from 'vitest'
import {
  ModelSlotArbiter,
  SlotAbortedError
} from '../../src/main/services/analysis/model-slot-arbiter'

// Whole-document-analysis plan §4.1 (H9/H10): the single model-slot arbiter that lets a
// yielding tree build cede the one chat runtime slot to an interactive answer and resume
// in-session — without ever both holding the slot. Tested in isolation (no DB/runtime).

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('ModelSlotArbiter', () => {
  it('reports no build active by default; chat acquire is an immediate no-op', async () => {
    const a = new ModelSlotArbiter()
    expect(a.isBuildActive()).toBe(false)
    const release = await a.acquireForChat()
    expect(typeof release).toBe('function')
    release() // must not throw
  })

  it('hands the slot from builder to chat and resumes the builder on release', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    expect(a.isBuildActive()).toBe(true)
    expect(a.shouldYield()).toBe(false)

    // Chat asks for the slot — it must WAIT for the builder to park.
    let acquired = false
    const acquire = a.acquireForChat().then((rel) => {
      acquired = true
      return rel
    })
    await tick()
    expect(acquired).toBe(false) // builder has not yielded yet
    expect(a.shouldYield()).toBe(true) // pause was requested

    // Builder reaches its node boundary, parks.
    let resumed = false
    const parked = a.reacquire('job1').then(() => {
      resumed = true
    })
    const release = await acquire
    expect(acquired).toBe(true) // chat now holds the slot
    expect(a.shouldYield()).toBe(false) // pause cleared on handoff

    await tick()
    expect(resumed).toBe(false) // builder still parked while chat streams

    release() // chat stream ended
    await parked
    expect(resumed).toBe(true) // builder resumed in-session, no restart
  })

  it('resumes the builder only after the LAST concurrent chat releases', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const acquire1 = a.acquireForChat()
    const acquire2 = a.acquireForChat()
    await tick()
    let resumed = false
    const parked = a.reacquire('job1').then(() => (resumed = true))
    const rel1 = await acquire1
    const rel2 = await acquire2

    rel1()
    await tick()
    expect(resumed).toBe(false) // one chat still holds the slot
    rel2()
    await parked
    expect(resumed).toBe(true)
  })

  it('rejects a parked reacquire on abort (cancel/lock/quit) — no hung await', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const acquire = a.acquireForChat()
    await tick()
    const parked = a.reacquire('job1')
    await acquire
    a.abort()
    await expect(parked).rejects.toBeInstanceOf(SlotAbortedError)
  })

  it('does not hang a chat acquire that races the build finishing', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const acquire = a.acquireForChat() // waits for a handoff that will never come
    await tick()
    a.unregisterBuild('job1') // build completed before yielding
    const release = await acquire // must resolve (slot is free)
    expect(a.isBuildActive()).toBe(false)
    release()
  })

  it('release is idempotent', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const acquire = a.acquireForChat()
    await tick()
    const parked = a.reacquire('job1')
    const release = await acquire
    release()
    release() // second call is a no-op, does not double-resume
    await expect(parked).resolves.toBeUndefined()
  })
})
