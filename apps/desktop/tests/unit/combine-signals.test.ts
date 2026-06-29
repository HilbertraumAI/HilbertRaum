import { describe, it, expect, vi, afterEach } from 'vitest'
import { combineSignals } from '../../src/main/services/runtime/sidecar'

// REL-4 (full-audit-2026-06-29): combineSignals owns its timeout timer and hands back clear() so
// an early-completing request — the norm — does not leave the timer pending for its full duration.
// A large ingestion runs hundreds of embed/rerank batches; an unref'd-but-uncleared timer (plus a
// live caller `abort` listener) per batch would otherwise pile up by the thousand before aging out.
describe('combineSignals — timeout timer lifecycle (REL-4)', () => {
  afterEach(() => vi.useRealTimers())

  it('clear() cancels the pending timeout timer so it never fires', () => {
    vi.useFakeTimers()
    const { signal, clear } = combineSignals(undefined, 1000)
    expect(signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(1) // the timeout is armed

    clear()
    expect(vi.getTimerCount()).toBe(0) // …and gone the moment the request settled
    // Teeth: skip the clearTimeout in clear() → the timer survives and aborts the signal here.
    vi.advanceTimersByTime(5000)
    expect(signal.aborted).toBe(false)
  })

  it('still aborts on timeout when not cleared, with the reason preserved as TimeoutError', () => {
    vi.useFakeTimers()
    const { signal } = combineSignals(undefined, 1000)
    vi.advanceTimersByTime(1000)
    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
  })

  it('still aborts promptly on a caller "Stop", carrying the caller reason', () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const { signal, clear } = combineSignals(caller.signal, 120_000)
    caller.abort(new DOMException('stopped by user', 'AbortError'))
    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('AbortError')
    // The long timer is still pending until the request settles — clear() removes it.
    clear()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts immediately for an already-aborted caller, and the timer stays clearable', () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    caller.abort(new DOMException('pre-aborted', 'AbortError'))
    const { signal, clear } = combineSignals(caller.signal, 1000)
    expect(signal.aborted).toBe(true)
    clear()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clear() is idempotent (double-clear is a no-op, never throws)', () => {
    vi.useFakeTimers()
    const { clear } = combineSignals(new AbortController().signal, 1000)
    expect(() => {
      clear()
      clear()
    }).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
