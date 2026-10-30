// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  analyze,
  clearVisionSession,
  selectImage,
  getVisionSession,
  stopActive,
  subscribeVisionPersisted,
  subscribeVisionSession
} from '../../src/renderer/lib/visionSession'
import type { ImageJob } from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { until } from '../helpers/hang-budget'
import { selectedImage, visionStream } from '../helpers/vision-fixtures'

// F8 (full audit 2026-06-30): the vision store's busy guard rejects a second analyze only once
// `activeJobId` is set — but that isn't set until AFTER the `imageAnalyze` create round-trip
// resolves. In the window before it, switching the image and starting a fresh analyze leaves two
// analyzes both awaiting `imageAnalyze`; the slower (superseded) one must NOT wire a zombie stream
// whose own late done/error would tear down the newer job's listeners. A per-call generation makes
// the superseded call bail (cancelling its orphan job) instead of wiring.

// The store is module-level: drop it after each test with the production purge `clearVisionSession()`.
afterEach(() => {
  assertNoUnexpectedApiCalls()
  clearVisionSession()
  vi.restoreAllMocks()
})

describe('visionSession — F8 superseded-analyze teardown', () => {
  it('a slow create round-trip that resolves after an image switch does not wire a zombie stream', async () => {
    // Two imageAnalyze calls, each parked until we resolve it, returning DISTINCT job ids.
    const resolvers: Array<(j: ImageJob) => void> = []
    const s = visionStream({ analyze: () => new Promise<ImageJob>((res) => resolvers.push(res)) })
    stubApi(s.api)

    // Job A starts on image A (create round-trip parked).
    selectImage(selectedImage('a.png'))
    const pA = analyze('question A')
    // Switch to image B and start job B — BOTH now awaiting imageAnalyze (A's activeJobId not set).
    selectImage(selectedImage('b.png'))
    const pB = analyze('question B')
    expect(resolvers).toHaveLength(2)

    // A's (superseded) create resolves first, then B's — main's initial job shape (vision/index.ts `analyze`).
    resolvers[0]({ jobId: 'jobA', state: 'queued' })
    await pA
    resolvers[1]({ jobId: 'jobB', state: 'queued' })
    await pB

    // A was superseded → cancelled main-side and NEVER wired a stream (teeth: without the gen
    // guard A wires, so imageCancel('jobA') is never called and A's listeners are live).
    expect(s.cancel).toHaveBeenCalledWith('jobA')
    expect(s.wired('jobA')).toBe(false)

    // The live job is B, and its stream is the one wired — a token lands on B's single turn
    // (on the PF-7c batch flush, so gate on the observable store state, not synchronously).
    expect(getVisionSession().activeJobId).toBe('jobB')
    s.token('jobB', 'hello')
    await until(() => getVisionSession().turns[0]?.answer === 'hello', 'the jobB token flush')
    const { turns } = getVisionSession()
    expect(turns).toHaveLength(1)
    expect(turns[0].question).toBe('question B')
  })
})

describe('visionSession — L6a busy guard (F-26)', () => {
  it('busy-guards a second analyze during the start round-trip; analyzing stays owned by the first', async () => {
    // The old guard (visionSession.ts:232) checked only `activeJobId`, which isn't set until AFTER
    // the imageAnalyze create round-trip resolves. A second analyze entering that window slipped
    // through; main busy-rejected it, and call 2's busy branch ran set({ analyzing:false }),
    // clobbering the still-live first job's flag (re-enabling the composer/drop-zone mid-stream — a
    // dropped image then cancels the live analyze). Port translateSession's L6a `|| analyzing` guard.
    const resolvers: Array<(j: ImageJob) => void> = []
    let calls = 0
    const s = visionStream({
      analyze: () => {
        calls += 1
        // Call 1 parks (create in flight, activeJobId not set yet); any later call resolves as the
        // deterministic main-side busy-reject (services/vision/index.ts one-at-a-time, `failedJob('busy')`).
        if (calls === 1) return new Promise<ImageJob>((res) => resolvers.push(res))
        return Promise.resolve<ImageJob>({ jobId: 'jobB', state: 'failed', error: 'busy' })
      }
    })
    stubApi(s.api)

    selectImage(selectedImage('a.png'))
    const first = analyze('question A') // flips analyzing:true, parked on imageAnalyze
    const second = await analyze('question B') // enters DURING the first's start round-trip
    expect(second).toBe('busy') // guarded at the store level, not sent to the backend
    expect(s.analyze).toHaveBeenCalledTimes(1) // the second never reached main
    expect(getVisionSession().analyzing).toBe(true) // still owned by the first, live job

    resolvers[0]({ jobId: 'jobA', state: 'queued' })
    await first
    expect(getVisionSession().activeJobId).toBe('jobA') // the first job wired normally
  })
})

// PF-7c (full-audit 2026-07-10, closes carried-forward PERF-5): the store used to notify per token
// with a freshly mapped `turns` array — every token re-rendered the Images screen. Tokens now
// buffer through a 40 ms flush (the ChatScreen STREAM_FLUSH_MS precedent): a burst inside one
// window produces ONE snapshot rebuild + ONE notify, and the settle paths flush FIRST so no
// token is ever lost.
describe('visionSession — PF-7c batched token flush', () => {
  it('a token burst inside one flush window produces exactly ONE notify', async () => {
    vi.useFakeTimers()
    let unsub = (): void => {}
    try {
      const s = visionStream()
      stubApi(s.api)
      selectImage(selectedImage())
      await analyze('question')
      const listener = vi.fn()
      unsub = subscribeVisionSession(listener)
      const before = getVisionSession()

      for (const tk of ['a', 'b', 'c', 'd', 'e']) s.token('j1', tk)
      // Buffered — nothing applied, the snapshot identity is untouched mid-window.
      expect(listener).not.toHaveBeenCalled()
      expect(getVisionSession()).toBe(before)

      await vi.advanceTimersByTimeAsync(40)
      expect(listener).toHaveBeenCalledTimes(1) // ONE batched notify for the whole burst
      expect(getVisionSession().turns[0].answer).toBe('abcde')
      expect(getVisionSession().turns[0].state).toBe('analyzing')
    } finally {
      // The production purge keeps the store's subscribers (an unmount drops a screen's), so unsubscribe here.
      unsub()
      vi.useRealTimers()
    }
  })

  it('done flushes the buffer first — the accumulated-answer fallback sees every token', async () => {
    const s = visionStream()
    stubApi(s.api)
    selectImage(selectedImage())
    await analyze('question')

    s.token('j1', 'partial ')
    s.token('j1', 'answer')
    // Done arrives INSIDE the flush window carrying no full text — the fallback reads the turn.
    // (Main always sends the answer on done; this pins the store's fallback for the optional field.)
    s.done('j1')
    expect(getVisionSession().turns[0].answer).toBe('partial answer')
    expect(getVisionSession().turns[0].state).toBe('done')
    expect(getVisionSession().analyzing).toBe(false)
  })

  // Main never sends this today: an empty answer is an `emptyResponse` ERROR event (vision/index.ts
  // `run` → `fail()`), and `done` carries the answer. `ImageJob.answer` is optional in the DTO, and this
  // pins the branch that guards it (moved from ImagesScreen's empty-`done` row, chat-ui campaign).
  it('a done carrying no usable answer settles the turn as emptyResponse and persists nothing (defensive: main sends emptiness as an error)', async () => {
    const s = visionStream()
    stubApi(s.api)
    const persisted = vi.fn()
    const unsub = subscribeVisionPersisted(persisted)
    try {
      selectImage(selectedImage())
      await analyze('question')
      s.done('j1', '   ')
      expect(getVisionSession().turns[0]).toMatchObject({ state: 'failed', error: 'emptyResponse' })
      expect(getVisionSession().analyzing).toBe(false)
      expect(persisted).not.toHaveBeenCalled()
    } finally {
      unsub()
    }
  })

  it('Stop flushes the buffer first — tokens already received land in the stopped turn', async () => {
    const s = visionStream()
    stubApi(s.api)
    selectImage(selectedImage())
    await analyze('question')

    s.token('j1', 'kept ')
    s.token('j1', 'text')
    stopActive() // inside the flush window
    expect(s.cancel).toHaveBeenCalledWith('j1')
    expect(getVisionSession().turns[0].answer).toBe('kept text')
    expect(getVisionSession().turns[0].state).toBe('cancelled')
  })
})

// DOC-4 (frontend audit 2026-08-09, #150 — the translateSession L5 mirror): the Stop button
// renders as soon as the turn is 'starting', BEFORE the imageAnalyze round-trip resolves and
// sets activeJobId. A Stop click in that window used to be a silent no-op (the analyze ran on
// to completion). Now it supersedes the in-flight start so its post-await branch cancels the
// just-started orphan job, and the turn lands 'cancelled'.
describe('visionSession — Stop during the start round-trip (DOC-4)', () => {
  it('supersedes the in-flight start: the orphan job is cancelled and the turn marked cancelled', async () => {
    const resolvers: Array<(j: ImageJob) => void> = []
    const s = visionStream({ analyze: () => new Promise<ImageJob>((res) => resolvers.push(res)) })
    stubApi(s.api)

    selectImage(selectedImage('a.png'))
    const p = analyze('what is this?')
    expect(getVisionSession().analyzing).toBe(true)
    expect(getVisionSession().activeJobId).toBeNull() // still inside the start round-trip

    // The pre-fix path: `!snapshot.activeJobId` → return — the click vanished (teeth).
    stopActive()
    expect(getVisionSession().analyzing).toBe(false)
    expect(getVisionSession().turns[0]?.state).toBe('cancelled')

    // The start resolves late — its supersede branch cancels the orphan and wires nothing.
    resolvers[0]({ jobId: 'orphan', state: 'queued' })
    await p
    expect(s.cancel).toHaveBeenCalledWith('orphan')
    expect(getVisionSession().activeJobId).toBeNull()
  })
})
