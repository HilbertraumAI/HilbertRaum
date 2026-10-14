// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  acknowledgeDocTask,
  cancelActiveDocTask,
  clearDocTaskSession,
  getActiveDocTask,
  markDocTaskCancelRequested,
  startTask,
  subscribeDocTask
} from '../../src/renderer/lib/doctasks'
import type { DocTaskStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// The doc-task store's deep-index chain adoption (#38): "Build deep index" starts a 'tree'
// task with `withExtract`; the BACKEND chains an 'extract' task over the same document after
// the tree succeeds. The store must adopt that follow-up (same timer, new jobId) so the row
// busy state and the chat task banner stay truthful through both passes — and must keep the
// ordinary terminal handling byte-identical for every other task.

afterEach(() => {
  clearDocTaskSession()
})

function status(over: Partial<DocTaskStatus>): DocTaskStatus {
  return {
    jobId: 'jt',
    kind: 'tree',
    documentIds: ['d1'],
    state: 'running',
    progress: { stepsDone: 0, stepsTotal: 0 },
    error: null,
    resultRef: null,
    ...over
  }
}

const POLL_MS = 400 // the store's private poll period (doctasks.ts POLL_MS)

// PF-7b (full-audit 2026-07-10): the 400 ms poll used to call setActive({...}) unconditionally —
// a fresh snapshot object per tick re-rendered every subscribed screen ~2.5×/s for a task's whole
// duration. An identical tick (the skillruns `sameRun` precedent, SKA-39) now sets nothing.
describe('doc-task store — no-change poll gate (PF-7b)', () => {
  it('does NOT re-notify on an identical poll tick', async () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const off = subscribeDocTask(listener)
    try {
      const running = status({ state: 'running', progress: { stepsDone: 1, stepsTotal: 3 } })
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        // A fresh object every poll, identical fields — the reference can never match.
        getDocTask: vi.fn(async () => ({ ...running, progress: { ...running.progress } }))
      })
      await startTask('summary', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS) // first tick: null status → running (one notify)
      expect(getActiveDocTask()?.status?.state).toBe('running')
      const after = listener.mock.calls.length
      const snapshotBefore = getActiveDocTask()
      await vi.advanceTimersByTimeAsync(POLL_MS * 3) // three identical ticks
      expect(listener.mock.calls.length).toBe(after) // no re-render churn
      expect(getActiveDocTask()).toBe(snapshotBefore) // snapshot identity stable between changes
    } finally {
      off()
      vi.useRealTimers()
    }
  })

  it('still notifies when a compared field changes (progress advance, then terminal)', async () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const off = subscribeDocTask(listener)
    try {
      const cur = { status: status({ state: 'running', progress: { stepsDone: 1, stepsTotal: 3 } }) }
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        getDocTask: vi.fn(async () => cur.status)
      })
      await startTask('summary', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS)
      const after = listener.mock.calls.length

      cur.status = status({ state: 'running', progress: { stepsDone: 2, stepsTotal: 3 } })
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(listener.mock.calls.length).toBe(after + 1) // progress advanced → one notify
      expect(getActiveDocTask()?.status?.progress.stepsDone).toBe(2)

      cur.status = status({ state: 'done', progress: { stepsDone: 3, stepsTotal: 3 } })
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(getActiveDocTask()?.status?.state).toBe('done') // terminal still lands + stops polling
    } finally {
      off()
      vi.useRealTimers()
    }
  })
})

// CODE-6 (full-audit 2026-07-11) — the SKA-40 tolerance ported from skillruns: ONE transient
// `getDocTask` rejection used to null the store (stopPolling + setActive(null)): the busy/Cancel
// UI vanished while the task still ran, `anyTaskActive` flipped false (re-enabled buttons then
// hit backend busy-rejects), and the done-task effect never fired — a finished summary never
// auto-opened, a failed task's error was never shown.
describe('doc-task store — poll-failure tolerance (CODE-6, SKA-40 port)', () => {
  it('tolerates a transient poll failure — the task is kept and its terminal state still surfaces', async () => {
    vi.useFakeTimers()
    try {
      let polls = 0
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        getDocTask: vi.fn(async () => {
          polls += 1
          // Tick 1 fails (the pre-fix drop), tick 2 recovers, tick 3 reports terminal.
          if (polls === 1) throw new Error('transient IPC error')
          return status({
            state: polls >= 3 ? 'done' : 'running',
            progress: { stepsDone: Math.min(polls, 3), stepsTotal: 3 }
          })
        })
      })
      await startTask('summary', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS) // the failing tick
      // Below MAX_POLL_FAILURES the task is RETAINED with an untouched snapshot (pre-fix: null).
      expect(getActiveDocTask()).not.toBeNull()
      expect(getActiveDocTask()?.stateUnknown).toBe(false)
      // The next successful polls still land, through to the terminal outcome.
      await vi.advanceTimersByTimeAsync(POLL_MS * 2)
      expect(getActiveDocTask()?.status?.state).toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after MAX_POLL_FAILURES consecutive failures — keeps a state-unknown task, never a silent drop', async () => {
    vi.useFakeTimers()
    try {
      const getDocTask = vi.fn(async () => {
        throw new Error('transient IPC error')
      })
      stubApi({ startDocTask: vi.fn(async () => ({ jobId: 'jt' })), getDocTask })
      await startTask('summary', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS * 3) // three consecutive failures = the max
      const task = getActiveDocTask()
      expect(task).not.toBeNull() // kept — anyTaskActive stays true, rows keep their busy state
      expect(task?.stateUnknown).toBe(true)
      // Give-up stops the polling loop: no further getDocTask churn.
      const callsAtGiveUp = getDocTask.mock.calls.length
      await vi.advanceTimersByTimeAsync(POLL_MS * 3)
      expect(getDocTask.mock.calls.length).toBe(callsAtGiveUp)
      // A state-unknown task is dismissible (mirrors skillruns' acknowledge) — never stuck forever.
      acknowledgeDocTask()
      expect(getActiveDocTask()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// #680: a tick used to write back the entry it captured BEFORE awaiting `getDocTask`, so anything
// that changed the entry during the round-trip was overwritten. `getDocTask` here resolves only
// when the test says so, which puts the change inside the round-trip.
describe('doc-task store — a poll in flight does not undo a change made meanwhile (#680)', () => {
  /** A `getDocTask` whose first call stays pending until `resolve`; later calls fail at once. */
  function onDemandPoll() {
    let resolveFirst: (s: DocTaskStatus) => void = () => {}
    let calls = 0
    const getDocTask = vi.fn((): Promise<DocTaskStatus> => {
      calls += 1
      if (calls > 1) return Promise.reject(new Error('transient IPC error'))
      return new Promise((r) => (resolveFirst = r))
    })
    return { getDocTask, resolve: (s: DocTaskStatus) => resolveFirst(s) }
  }
  const ocr = (over: Partial<DocTaskStatus> = {}) =>
    status({ kind: 'ocr', progress: { stepsDone: 0, stepsTotal: 5 }, ...over })

  it('a Cancel latched while a poll is in flight survives the tick (DOC-5, #150)', async () => {
    vi.useFakeTimers()
    try {
      const poll = onDemandPoll()
      stubApi({ startDocTask: vi.fn(async () => ({ jobId: 'jt' })), getDocTask: poll.getDocTask })
      await startTask('ocr', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS) // the tick fires and awaits getDocTask
      markDocTaskCancelRequested() // the user clicks Cancel during the round-trip
      expect(getActiveDocTask()?.cancelRequested).toBe(true)
      poll.resolve(ocr({ progress: { stepsDone: 1, stepsTotal: 5 } })) // a progress change lands
      await vi.advanceTimersByTimeAsync(0)
      expect(getActiveDocTask()?.status?.progress.stepsDone).toBe(1)
      expect(getActiveDocTask()?.cancelRequested).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a lock purge while a poll is in flight is not undone by the tick (SH-4, #149)', async () => {
    vi.useFakeTimers()
    try {
      const poll = onDemandPoll()
      stubApi({ startDocTask: vi.fn(async () => ({ jobId: 'jt' })), getDocTask: poll.getDocTask })
      await startTask('ocr', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS)
      clearDocTaskSession() // purgeSessionStores at the workspace lock
      expect(getActiveDocTask()).toBeNull()
      poll.resolve(ocr({ state: 'cancelled' })) // main aborted the task at the lock
      await vi.advanceTimersByTimeAsync(0)
      expect(getActiveDocTask()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a lock purge during the deep-index chain read is not undone either (#38)', async () => {
    vi.useFakeTimers()
    try {
      let resolveActive: (s: DocTaskStatus) => void = () => {}
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        getDocTask: vi.fn(async () => status({ state: 'done' })),
        getActiveDocTask: vi.fn(() => new Promise<DocTaskStatus>((r) => (resolveActive = r)))
      })
      await startTask('tree', 'd1', { withExtract: true })
      await vi.advanceTimersByTimeAsync(POLL_MS) // the tree reports done; the tick asks for the follow-up
      clearDocTaskSession()
      resolveActive(status({ jobId: 'jx', kind: 'extract', state: 'running' }))
      await vi.advanceTimersByTimeAsync(0)
      expect(getActiveDocTask()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a newer task started while a poll is in flight keeps its entry and its timer', async () => {
    vi.useFakeTimers()
    try {
      let resolveA: (s: DocTaskStatus) => void = () => {}
      const ids = ['ja', 'jb']
      const getDocTask = vi.fn(
        (id: string): Promise<DocTaskStatus> =>
          id === 'ja'
            ? new Promise((r) => (resolveA = r))
            : Promise.resolve(status({ jobId: 'jb', kind: 'summary', documentIds: ['d2'] }))
      )
      stubApi({ startDocTask: vi.fn(async () => ({ jobId: ids.shift() ?? 'none' })), getDocTask })
      await startTask('ocr', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS) // task A's tick awaits getDocTask
      await startTask('summary', 'd2') // task B replaces A
      resolveA(ocr({ jobId: 'ja', state: 'done' })) // A's late, terminal answer
      await vi.advanceTimersByTimeAsync(0)
      expect(getActiveDocTask()?.jobId).toBe('jb')
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(getDocTask).toHaveBeenLastCalledWith('jb') // A's terminal tick did not stop B's timer
      expect(getActiveDocTask()?.status?.jobId).toBe('jb')
    } finally {
      vi.useRealTimers()
    }
  })

  it("a replaced task's failed poll does not count against the newer task (CODE-6)", async () => {
    vi.useFakeTimers()
    try {
      let rejectA: (e: Error) => void = () => {}
      const ids = ['ja', 'jb']
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: ids.shift() ?? 'none' })),
        getDocTask: vi.fn(
          (id: string): Promise<DocTaskStatus> =>
            id === 'ja'
              ? new Promise((_, reject) => (rejectA = reject))
              : Promise.reject(new Error('transient IPC error'))
        )
      })
      await startTask('ocr', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS)
      await startTask('summary', 'd2')
      rejectA(new Error('transient IPC error')) // A's late failure
      await vi.advanceTimersByTimeAsync(POLL_MS * 2) // B's own two failures: below the give-up
      expect(getActiveDocTask()?.stateUnknown).toBe(false)
      await vi.advanceTimersByTimeAsync(POLL_MS) // B's third failure gives up, as it should
      expect(getActiveDocTask()?.stateUnknown).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a poll slower than the period is not overlapped, so a late success cannot revive a task nobody polls', async () => {
    vi.useFakeTimers()
    try {
      const poll = onDemandPoll()
      stubApi({ startDocTask: vi.fn(async () => ({ jobId: 'jt' })), getDocTask: poll.getDocTask })
      await startTask('ocr', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS) // the first poll is slow
      // Overlapping ticks would each fail fast here and give up (CODE-6) with the timer stopped;
      // the slow success landing afterwards then wrote back a running task that nothing polls.
      await vi.advanceTimersByTimeAsync(POLL_MS * 3)
      expect(poll.getDocTask).toHaveBeenCalledTimes(1)
      poll.resolve(ocr({ progress: { stepsDone: 2, stepsTotal: 5 } }))
      await vi.advanceTimersByTimeAsync(0)
      expect(getActiveDocTask()?.status?.progress.stepsDone).toBe(2)
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(poll.getDocTask).toHaveBeenCalledTimes(2) // still polled after the slow tick
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rejected cancel clears the latch, so Cancel is offered again (CODE-29)', async () => {
    stubApi({
      startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
      getDocTask: vi.fn(async () => ocr()),
      cancelDocTask: vi.fn(async () => {
        throw new Error('cancel exploded')
      })
    })
    await startTask('ocr', 'd1')
    markDocTaskCancelRequested() // DocRow latches before it calls onCancelTask
    await expect(cancelActiveDocTask()).rejects.toThrow('cancel exploded')
    expect(getActiveDocTask()?.jobId).toBe('jt')
    expect(getActiveDocTask()?.cancelRequested).toBeFalsy()
  })
})

// #689: the Documents row's Cancel sends the store entry's id (DocumentSummary.test.tsx pins the
// click; the #38 describe below pins it after a chain adoption).
describe("doc-task store — the row's cancel names its own task (#689)", () => {
  // With no id, main cancels whatever holds the lane. With no entry the store has no task of its
  // own to name, so it sends nothing at all.
  it('a cancel with no entry sends nothing', async () => {
    const cancelDocTask = vi.fn(async () => {})
    stubApi({ cancelDocTask })
    await cancelActiveDocTask()
    expect(cancelDocTask).not.toHaveBeenCalled()
  })
})

describe('doc-task store — deep-index chain adoption (#38)', () => {
  it('adopts the chained extract task after a withExtract tree completes', async () => {
    vi.useFakeTimers()
    try {
      const treeDone = status({ jobId: 'jt', kind: 'tree', state: 'done' })
      const extractRunning = status({ jobId: 'jx', kind: 'extract', state: 'running' })
      const extractDone = status({ jobId: 'jx', kind: 'extract', state: 'done' })
      let extractPolls = 0
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        getDocTask: vi.fn(async (id: string) => {
          if (id === 'jt') return treeDone
          extractPolls += 1
          return extractPolls > 1 ? extractDone : extractRunning
        }),
        getActiveDocTask: vi.fn(async () => extractRunning)
      })

      await startTask('tree', 'd1', { withExtract: true })
      await vi.advanceTimersByTimeAsync(POLL_MS) // tick 1: the tree reports done → the running extract is adopted
      // The store switches from the finished tree job to the chained extract job…
      expect(getActiveDocTask()?.jobId).toBe('jx')
      expect(getActiveDocTask()?.kind).toBe('extract')
      expect(getActiveDocTask()?.documentIds).toEqual(['d1'])
      expect(getActiveDocTask()?.status?.state).toBe('running')
      // …and keeps polling it to ITS terminal state on the same timer.
      await vi.advanceTimersByTimeAsync(POLL_MS * 2) // tick 2: jx still running; tick 3: jx done — same timer
      expect(getActiveDocTask()?.status?.state).toBe('done')
      expect(getActiveDocTask()?.jobId).toBe('jx')
    } finally {
      vi.useRealTimers()
    }
  })

  // #689: the row's Cancel names the task the entry holds NOW. After the adoption that is the
  // extract; the tree's id would reach a finished task.
  it('a cancel after the adoption targets the adopted extract', async () => {
    vi.useFakeTimers()
    try {
      const cancelDocTask = vi.fn(async () => {})
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        getDocTask: vi.fn(async (id: string) =>
          id === 'jt' ? status({ jobId: 'jt', state: 'done' }) : status({ jobId: 'jx', kind: 'extract' })
        ),
        getActiveDocTask: vi.fn(async () => status({ jobId: 'jx', kind: 'extract' })),
        cancelDocTask
      })

      await startTask('tree', 'd1', { withExtract: true })
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(getActiveDocTask()?.jobId).toBe('jx')
      await cancelActiveDocTask()
      expect(cancelDocTask).toHaveBeenCalledTimes(1)
      expect(cancelDocTask).toHaveBeenCalledWith('jx')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the ordinary terminal handling when the chain was dropped (no follow-up running)', async () => {
    vi.useFakeTimers()
    try {
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        getDocTask: vi.fn(async () => status({ state: 'done' })),
        getActiveDocTask: vi.fn(async () => null)
      })

      await startTask('tree', 'd1', { withExtract: true })
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(getActiveDocTask()?.status?.state).toBe('done')
      expect(getActiveDocTask()?.jobId).toBe('jt') // terminal stays visible for acknowledgement
    } finally {
      vi.useRealTimers()
    }
  })

  it('never adopts on a plain task (no withExtract) — even when some other task is running', async () => {
    vi.useFakeTimers()
    try {
      const getActive = vi.fn(async () => status({ jobId: 'other', kind: 'summary', state: 'running' }))
      stubApi({
        startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
        getDocTask: vi.fn(async () => status({ state: 'done' })),
        getActiveDocTask: getActive
      })

      await startTask('tree', 'd1')
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(getActiveDocTask()?.status?.state).toBe('done')
      expect(getActiveDocTask()?.jobId).toBe('jt')
      expect(getActive).not.toHaveBeenCalled() // byte-identical polling for every other task
    } finally {
      vi.useRealTimers()
    }
  })
})
