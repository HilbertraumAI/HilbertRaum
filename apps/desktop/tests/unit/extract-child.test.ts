import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { makeTarExtractor, type ExtractSpawn } from '../../src/main/services/runtime-download'

// #999: the engine extractor settles only after its tar has exited. A cancel (or the deadline) kills
// the child, SIGTERM then SIGKILL after the grace; the extraction rejects on the child's `exit`, or,
// for a child that outlives even SIGKILL (wedged in kernel I/O on a failing stick), after a bound with
// a log line. It used to reject at once, so the job read idle and deleted its staging folder while tar
// could still write into it. The child here is a fake (an EventEmitter with a `kill` spy) through the
// `makeTarExtractor({ spawn })` seam; the real tar's timing was measured (2–5 ms from kill to exit on
// Windows) and runs in the OS-tar rows of engine-download.test.ts and engine-swap.test.ts.

/** A child that exits only when the row says so. */
function fakeTar(): { child: ChildProcess & EventEmitter; kill: ReturnType<typeof vi.fn>; spawn: ExtractSpawn } {
  const emitter = new EventEmitter()
  const kill = vi.fn((_signal?: NodeJS.Signals) => true)
  const child = Object.assign(emitter, { kill }) as unknown as ChildProcess & EventEmitter
  return { child, kill, spawn: () => child }
}

/** The extraction's outcome as it stands, without awaiting it. */
function track(p: Promise<void>): { settled: boolean; error: Error | null; resolved: boolean } {
  const state = { settled: false, error: null as Error | null, resolved: false }
  p.then(
    () => Object.assign(state, { settled: true, resolved: true }),
    (err: Error) => Object.assign(state, { settled: true, error: err })
  )
  return state
}

/** Let every pending promise callback run (no timer involved). */
const drain = (): Promise<void> => new Promise((r) => setImmediate(r))

const DIR = join('drive', 'runtime', 'llama.cpp', 'win.new')
const ARCHIVE = join(DIR, 'llama.zip')

afterEach(() => {
  vi.useRealTimers()
  delete process.env.HILBERTRAUM_EXTRACT_DEADLINE_MS
})

describe('the extractor settles only after its tar has exited (#999)', () => {
  it('a cancel kills the child and rejects only once the child has exited', async () => {
    const { child, kill, spawn } = fakeTar()
    const extract = makeTarExtractor({ spawn })
    const cancel = new AbortController()
    const outcome = track(extract(ARCHIVE, DIR, cancel.signal))
    cancel.abort()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill.mock.calls[0]).toEqual([])
    await drain()
    // Before #999 the extraction had rejected here, with tar still running.
    expect(outcome.settled).toBe(false)
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await drain()
    expect(outcome).toMatchObject({ settled: true, resolved: false })
    expect(outcome.error?.message).toBe('tar extraction cancelled')
  })

  it('a child that never exits gets SIGKILL after the grace, and the extraction gives up on it after the bound', async () => {
    vi.useFakeTimers()
    const { kill, spawn } = fakeTar()
    const log = vi.fn()
    const extract = makeTarExtractor({ spawn, graceMs: 2_000, goneBoundMs: 10_000 })
    const cancel = new AbortController()
    const outcome = track(extract(ARCHIVE, DIR, cancel.signal, log))
    cancel.abort()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(kill.mock.calls).toEqual([[]])
    await vi.advanceTimersByTimeAsync(1)
    expect(kill.mock.calls).toEqual([[], ['SIGKILL']])
    await vi.advanceTimersByTimeAsync(9_999)
    expect(outcome.settled).toBe(false)
    expect(log).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error?.message).toBe('tar extraction cancelled')
    expect(log).toHaveBeenCalledWith('tar did not exit after it was killed: the extraction is given up on', {
      graceMs: 2_000,
      goneBoundMs: 10_000
    })
  })

  it('the deadline (HILBERTRAUM_EXTRACT_DEADLINE_MS) stops a wedged tar the same way', async () => {
    vi.useFakeTimers()
    process.env.HILBERTRAUM_EXTRACT_DEADLINE_MS = '500'
    const { kill, spawn } = fakeTar()
    const extract = makeTarExtractor({ spawn, graceMs: 100, goneBoundMs: 1_000 })
    const outcome = track(extract(ARCHIVE, DIR))
    await vi.advanceTimersByTimeAsync(499)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(kill.mock.calls).toEqual([[]])
    await vi.advanceTimersByTimeAsync(100)
    expect(kill.mock.calls).toEqual([[], ['SIGKILL']])
    await vi.advanceTimersByTimeAsync(999)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error?.message).toBe('tar extraction exceeded 500 ms; aborted')
  })

  it('after a stop, a kill that could not be delivered is not taken for the exit', async () => {
    const { child, spawn } = fakeTar()
    const extract = makeTarExtractor({ spawn })
    const cancel = new AbortController()
    const outcome = track(extract(ARCHIVE, DIR, cancel.signal))
    cancel.abort()
    child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }))
    await drain()
    expect(outcome.settled).toBe(false)
    child.emit('exit', 1, null)
    await drain()
    expect(outcome.error?.message).toBe('tar extraction cancelled')
  })

  // Controls: an extraction nobody stopped settles on tar's own exit, as before.
  it.each([
    [0, null],
    [1, 'tar exited with code 1']
  ])('an extraction that ends by itself with code %s settles on close', async (code, message) => {
    const { child, kill, spawn } = fakeTar()
    const outcome = track(makeTarExtractor({ spawn })(ARCHIVE, DIR))
    child.emit('exit', code, null)
    child.emit('close', code, null)
    await drain()
    expect(outcome.settled).toBe(true)
    expect(outcome.error?.message ?? null).toBe(message)
    expect(kill).not.toHaveBeenCalled()
  })

  it('a tar that cannot be started rejects with the spawn error', async () => {
    const { child, spawn } = fakeTar()
    const outcome = track(makeTarExtractor({ spawn })(ARCHIVE, DIR))
    child.emit('error', Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT', syscall: 'spawn tar' }))
    await drain()
    expect(outcome.error?.message).toBe('spawn tar ENOENT')
  })
})
