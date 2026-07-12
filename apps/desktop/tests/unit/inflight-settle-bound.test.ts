import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  awaitInFlightStreamsSettled,
  STREAM_SETTLE_TIMEOUT_MS
} from '../../src/main/ipc/inflight'
import { performShutdown } from '../../src/main/shutdown'
import type { AppContext } from '../../src/main/services/context'

// full-audit 2026-07-12 REL-4 — the in-flight-stream settle await is BOUNDED (the 5 s
// doc-task settle treatment). The settle promises never reject (resolved in the stream
// wrapper's `finally`), but one wedged for any other reason used to stall quit/lock forever
// → the user hard-kills → mid-session wal state → next-launch shred. The ceiling lives
// inside `awaitInFlightStreamsSettled`, covering BOTH callers (performShutdown and the
// interactive-lock handler) in one place; after it fires the teardown proceeds, forfeiting
// only the wedged stream's partial-reply persistence.

afterEach(() => {
  vi.useRealTimers()
})

describe('awaitInFlightStreamsSettled ceiling (full-audit 2026-07-12 REL-4)', () => {
  it('resolves after the ceiling when a settle never resolves (wedged stream)', async () => {
    const never = new Map<string, Promise<void>>([['c1', new Promise<void>(() => {})]])
    const start = Date.now()
    // Pre-fix this awaited the never-resolving allSettled forever (vitest test timeout).
    await awaitInFlightStreamsSettled(never, 40)
    expect(Date.now() - start).toBeLessThan(STREAM_SETTLE_TIMEOUT_MS)
  })

  it('resolves promptly when the settles finish — never waits out the ceiling', async () => {
    const settled = new Map<string, Promise<void>>([
      ['c1', Promise.resolve()],
      ['c2', Promise.resolve()]
    ])
    const start = Date.now()
    await awaitInFlightStreamsSettled(settled, STREAM_SETTLE_TIMEOUT_MS)
    expect(Date.now() - start).toBeLessThan(1_000) // the race resolved on the settles
  })

  it('quit proceeds after the ceiling with a never-settling stream (performShutdown wiring)', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const fakeCtx = {
      runtime: { shutdown: () => {}, stop: async () => {} },
      embedder: {},
      workspace: { shutdown: () => order.push('lock') }
    } as unknown as AppContext

    const p = performShutdown(fakeCtx, {
      inFlightStreams: new Map(),
      streamSettled: new Map<string, Promise<void>>([['c1', new Promise<void>(() => {})]]),
      detachVaultKey: () => order.push('detach'),
      log: { error: () => undefined }
    })

    // Before the ceiling the teardown is parked on the wedged settle: lock() has not run.
    await vi.advanceTimersByTimeAsync(STREAM_SETTLE_TIMEOUT_MS - 1)
    expect(order).not.toContain('lock')

    // The ceiling fires → the teardown PROCEEDS to detach + lock (pre-fix: wedged forever).
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(order).toEqual(['detach', 'lock'])
  })
})
