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

  it('a second concurrent chat does not deadlock when the build is already parked', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    // Chat A pauses the build and waits for the handoff.
    const acquireA = a.acquireForChat()
    await tick()
    const parked = a.reacquire('job1') // builder parks (slot handed to chat A)
    const relA = await acquireA

    // Chat B arrives while the build is parked — it must proceed IMMEDIATELY (the slot is
    // already away from the builder), not wait for a handoff that will never come.
    let bAcquired = false
    const relB = await a.acquireForChat().then((r) => {
      bAcquired = true
      return r
    })
    expect(bAcquired).toBe(true)

    // The build resumes only after BOTH chats release.
    let resumed = false
    void parked.then(() => (resumed = true))
    relA()
    await tick()
    expect(resumed).toBe(false)
    relB()
    await parked
    expect(resumed).toBe(true)
  })

  it('a fresh build is not poisoned by a prior build s leftover handshake state', async () => {
    const a = new ModelSlotArbiter()
    // Simulate a prior build that left chatHolders > 0 (e.g. an unbalanced release path).
    a.registerBuild('old')
    void a.acquireForChat() // chatHolders -> 1 (never released)
    await tick()
    a.unregisterBuild('old')

    // A new build must start clean: a pause/handoff/resume cycle works normally.
    a.registerBuild('new')
    const acquire = a.acquireForChat()
    await tick()
    let resumed = false
    const parked = a.reacquire('new').then(() => (resumed = true))
    const release = await acquire
    release()
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

  // REL-3: a "Stop" that lands while a chat is PARKED waiting for the builder's handoff
  // (the builder is mid-node, a multi-second generate) must unwind that chat immediately —
  // not after the node finishes. The aborted waiter is removed from the queue (not leaked)
  // and the pause it requested is dropped, so the builder doesn't needlessly park for a chat
  // that's gone (which, with no chat left to release it, would hang the build).
  it('rejects a chat acquire when its signal aborts during the handoff wait, and unwinds cleanly (REL-3)', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const controller = new AbortController()
    const acquire = a.acquireForChat(controller.signal)
    await tick()
    expect(a.shouldYield()).toBe(true) // pause requested while the chat waits
    controller.abort()
    await expect(acquire).rejects.toBeInstanceOf(SlotAbortedError)
    // The gone chat left no trace: pause dropped (it was the only waiter) so the builder's
    // next boundary does NOT park (which would hang — no chat remains to release it).
    expect(a.shouldYield()).toBe(false)
    // The build still pauses+resumes normally for a subsequent chat (no leaked chatHolders).
    const acquire2 = a.acquireForChat()
    await tick()
    let resumed = false
    const parked = a.reacquire('job1').then(() => (resumed = true))
    const rel = await acquire2
    rel()
    await parked
    expect(resumed).toBe(true)
  })

  it('one chat aborting during the wait keeps the pause + handoff for a co-waiting chat (REL-3)', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const c1 = new AbortController()
    const acquire1 = a.acquireForChat(c1.signal)
    const acquire2 = a.acquireForChat() // a second chat also waits for the handoff
    await tick()
    expect(a.shouldYield()).toBe(true)
    c1.abort()
    await expect(acquire1).rejects.toBeInstanceOf(SlotAbortedError)
    expect(a.shouldYield()).toBe(true) // still paused for the surviving chat 2
    // The builder hands off to chat 2; it resumes only after chat 2 releases — proving the
    // aborted chat 1 gave back its holder count (else chatHolders would never reach 0).
    let resumed = false
    const parked = a.reacquire('job1').then(() => (resumed = true))
    const rel2 = await acquire2
    await tick()
    expect(resumed).toBe(false)
    rel2()
    await parked
    expect(resumed).toBe(true)
  })

  it('an already-aborted signal makes a chat acquire reject without taking the slot (REL-3)', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const controller = new AbortController()
    controller.abort() // already stopped before we even ask
    await expect(a.acquireForChat(controller.signal)).rejects.toBeInstanceOf(SlotAbortedError)
    // No pause was requested and the builder is untouched — a fresh chat still works.
    expect(a.shouldYield()).toBe(false)
    const acquire = a.acquireForChat()
    await tick()
    let resumed = false
    const parked = a.reacquire('job1').then(() => (resumed = true))
    ;(await acquire)()
    await parked
    expect(resumed).toBe(true)
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

  // R2 (full-audit-2026-06-30, Phase C): the FAST PATH — a chat that acquires while the builder is
  // ALREADY parked (`reacquireReject !== null`) — used to install NO abort listener (it skips
  // waitForHandoff). So aborting a fast-path holder freed its `chatHolders` slot only when
  // withChatStream's `finally` later ran the returned release fn — a transient stall in which the
  // build resumed only via the OTHER chat. The fix installs the release-on-abort on BOTH paths.
  it('aborting a FAST-PATH (build-already-parked) chat holder releases its slot promptly (R2)', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    // Chat A pauses the build and is handed the slot (slow path).
    const acquireA = a.acquireForChat()
    await tick()
    const parked = a.reacquire('job1') // builder parks → reacquireReject set → next acquire is fast
    const relA = await acquireA
    // Chat B arrives while the build is parked → FAST PATH. We deliberately DON'T keep its release
    // fn: the abort listener (R2) must be what frees B's holder slot.
    const ctrlB = new AbortController()
    await a.acquireForChat(ctrlB.signal)

    let resumed = false
    void parked.then(() => (resumed = true))

    ctrlB.abort() // R2: the fast-path abort listener releases B's holder slot
    await tick()
    expect(resumed).toBe(false) // A still holds the slot → build NOT resumed yet
    relA() // the surviving chat releases
    await tick()
    // FIXED: B was released by its abort, A by relA → chatHolders hit 0 → build resumes. UNFIXED:
    // B's abort installed no listener and its release fn was never called → chatHolders stuck at 1
    // → the build never resumes → this reddens.
    expect(resumed).toBe(true)
  })

  it('a FAST-PATH holder freed by abort is idempotent with its release fn (R2 — no double-release)', async () => {
    const a = new ModelSlotArbiter()
    a.registerBuild('job1')
    const acquireA = a.acquireForChat()
    await tick()
    const parked = a.reacquire('job1')
    const relA = await acquireA
    const ctrlB = new AbortController()
    const relB = await a.acquireForChat(ctrlB.signal) // FAST PATH

    let resumed = false
    void parked.then(() => (resumed = true))

    // Both the abort listener AND the returned release fn (as withChatStream's finally calls it)
    // fire for B — they share ONE `released` latch, so the slot is given back EXACTLY once.
    ctrlB.abort()
    relB()
    await tick()
    // A naive fix that decremented twice would have hit chatHolders 0 here and resumed the build
    // while A still holds → this pins single-release.
    expect(resumed).toBe(false)
    relA()
    await tick()
    expect(resumed).toBe(true)
  })
})
