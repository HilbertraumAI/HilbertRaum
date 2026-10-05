import { describe, it, expect } from 'vitest'
import { withDocumentLock, activeDocumentLockCount } from '../../src/main/services/skills/doc-lock'

// The per-document lock's own contract (skills-tools-audit-2026-06-26 PC-1; SKA-24 abort handling). Pure —
// no DB. Lives in its own file because `activeDocumentLockCount()` reads module-global chain state: the
// forks pool gives each file a fresh module, so a leaked chain in a DB-backed suite
// (skills-concurrency.test.ts) can never poison these counts.

describe('withDocumentLock', () => {
  it('SKA-24: an aborted PARKED waiter rejects immediately, never runs, and a THIRD caller still acquires', async () => {
    // The chain invariant under abort: the waiter's tail is PUBLISHED before it parks, so the abort
    // path must still settle it (release + prune) — otherwise every later caller deadlocks forever.
    const docId = 'doc-abort-parked'
    let releaseHolder!: () => void
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    const order: string[] = []

    // Caller 1 HOLDS the lock (parked inside its own fn, like a long categorize).
    let holderStarted!: () => void
    const holderAcquired = new Promise<void>((resolve) => {
      holderStarted = resolve
    })
    const holder = withDocumentLock(docId, async () => {
      order.push('holder:start')
      holderStarted()
      await holderGate
      order.push('holder:end')
    })
    await holderAcquired // the holder provably holds the lock

    // Caller 2 parks behind it with a signal, then aborts.
    const ac = new AbortController()
    let waiterRan = false
    const waiter = withDocumentLock(docId, async () => {
      waiterRan = true
    }, ac.signal)
    const waiterErr = waiter.then(
      () => null,
      (e: unknown) => e
    )
    ac.abort()
    // Assertions before the holder releases run in a try/finally: a red one must still release the
    // gate, or the leaked module-global chain poisons every later activeDocumentLockCount() test.
    try {
      const err = await waiterErr // rejects IMMEDIATELY — the holder is still parked on its gate
      expect(err).toBeInstanceOf(DOMException)
      expect((err as DOMException).name).toBe('AbortError')
      expect(waiterRan).toBe(false)
      expect(order).toEqual(['holder:start']) // the holder had NOT finished when the waiter rejected
    } finally {
      releaseHolder()
    }

    // Caller 3 (no signal) queues after the aborted waiter — the chain must not be wedged.
    const third = withDocumentLock(docId, async () => {
      order.push('third')
      return 7
    })
    await holder
    expect(await third).toBe(7)
    expect(order).toEqual(['holder:start', 'holder:end', 'third'])
    await Promise.resolve() // let the aborted waiter's deferred prune run
    expect(activeDocumentLockCount()).toBe(0) // no leaked chain entry from the aborted waiter
  })

  it('SKA-24: an already-aborted caller facing a FREE lock still runs fn (the seam records the honest cancel)', async () => {
    const ac = new AbortController()
    ac.abort()
    let ran = false
    await withDocumentLock('doc-abort-free', async () => {
      ran = true
    }, ac.signal)
    expect(ran).toBe(true) // pre-R9 behaviour preserved: the seam's own first signal check owns this case
    expect(activeDocumentLockCount()).toBe(0)
  })

  it('withDocumentLock is re-entrant within one async chain (a nested same-doc acquire does not deadlock)', async () => {
    // The load-bearing property for the lane wraps: the analysis handler / runCategorize hold the lock
    // across a sequence AND call self-locking seams inside. A nested acquire of an already-held id must
    // run inline rather than await the outer hold forever.
    const docId = 'doc-reentrant'
    const seen: string[] = []
    const result = await withDocumentLock(docId, async () => {
      seen.push('outer')
      const inner = await withDocumentLock(docId, async () => {
        seen.push('inner')
        return 42
      })
      return inner
    })
    expect(result).toBe(42)
    expect(seen).toEqual(['outer', 'inner'])
    expect(activeDocumentLockCount()).toBe(0)
  })
})
