// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  analyze,
  selectImage,
  getVisionSession,
  resetVisionSessionForTests,
  stopActive,
  subscribeVisionSession,
  type SelectedImage
} from '../../src/renderer/lib/visionSession'
import type { DecodedImage } from '../../src/renderer/images'
import { stubApi } from '../helpers/renderer'

// F8 (full audit 2026-06-30): the vision store's busy guard rejects a second analyze only once
// `activeJobId` is set — but that isn't set until AFTER the `imageAnalyze` create round-trip
// resolves. In the window before it, switching the image and starting a fresh analyze leaves two
// analyzes both awaiting `imageAnalyze`; the slower (superseded) one must NOT wire a zombie stream
// whose own late done/error would tear down the newer job's listeners. A per-call generation makes
// the superseded call bail (cancelling its orphan job) instead of wiring.

afterEach(() => {
  resetVisionSessionForTests()
  vi.restoreAllMocks()
})

function img(name: string): SelectedImage {
  const decoded: DecodedImage = {
    bytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
    width: 10,
    height: 10
  }
  return { decoded, name, sizeBytes: 4 }
}

describe('visionSession — F8 superseded-analyze teardown', () => {
  it('a slow create round-trip that resolves after an image switch does not wire a zombie stream', async () => {
    // Two imageAnalyze calls, each parked until we resolve it, returning DISTINCT job ids.
    const resolvers: Array<(j: unknown) => void> = []
    const imageAnalyze = vi.fn(() => new Promise((res) => resolvers.push(res)))
    const imageCancel = vi.fn(async () => ({ jobId: 'x', state: 'cancelled' }))
    // Capture the per-job token subscriber so we can drive (only) the live job's stream.
    const tokenCbs: Record<string, (t: string) => void> = {}
    const onImageToken = vi.fn((id: string, cb: (t: string) => void) => {
      tokenCbs[id] = cb
      return () => delete tokenCbs[id]
    })
    stubApi({
      imageAnalyze,
      imageCancel,
      onImageToken,
      onImageDone: vi.fn(() => () => {}),
      onImageError: vi.fn(() => () => {})
    } as never)

    // Job A starts on image A (create round-trip parked).
    selectImage(img('a.png'))
    const pA = analyze('question A')
    // Switch to image B and start job B — BOTH now awaiting imageAnalyze (A's activeJobId not set).
    selectImage(img('b.png'))
    const pB = analyze('question B')
    expect(resolvers).toHaveLength(2)

    // A's (superseded) create resolves first, then B's.
    resolvers[0]({ jobId: 'jobA', state: 'starting' })
    await pA
    resolvers[1]({ jobId: 'jobB', state: 'starting' })
    await pB

    // A was superseded → cancelled main-side and NEVER wired a stream (teeth: without the gen
    // guard A wires, so imageCancel('jobA') is never called and tokenCbs['jobA'] is defined).
    expect(imageCancel).toHaveBeenCalledWith('jobA')
    expect(tokenCbs.jobA).toBeUndefined()

    // The live job is B, and its stream is the one wired — a token lands on B's single turn
    // (on the PF-7c batch flush, so gate on the observable store state, not synchronously).
    expect(getVisionSession().activeJobId).toBe('jobB')
    tokenCbs.jobB?.('hello')
    await until(() => getVisionSession().turns[0]?.answer === 'hello')
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
    const resolvers: Array<(j: unknown) => void> = []
    let calls = 0
    const imageAnalyze = vi.fn(() => {
      calls += 1
      // Call 1 parks (create in flight, activeJobId not set yet); any later call resolves as the
      // deterministic main-side busy-reject (services/vision/index.ts one-at-a-time).
      if (calls === 1) return new Promise((res) => resolvers.push(res))
      return Promise.resolve({ jobId: 'jobB', state: 'failed', error: 'busy' })
    })
    stubApi({
      imageAnalyze,
      imageCancel: vi.fn(async () => ({ jobId: 'x', state: 'cancelled' })),
      onImageToken: vi.fn(() => () => {}),
      onImageDone: vi.fn(() => () => {}),
      onImageError: vi.fn(() => () => {})
    } as never)

    selectImage(img('a.png'))
    const first = analyze('question A') // flips analyzing:true, parked on imageAnalyze
    const second = await analyze('question B') // enters DURING the first's start round-trip
    expect(second).toBe('busy') // guarded at the store level, not sent to the backend
    expect(imageAnalyze).toHaveBeenCalledTimes(1) // the second never reached main
    expect(getVisionSession().analyzing).toBe(true) // still owned by the first, live job

    resolvers[0]({ jobId: 'jobA', state: 'starting' })
    await first
    expect(getVisionSession().activeJobId).toBe('jobA') // the first job wired normally
  })
})

/** Poll until `pred` holds (the store's flush window is 40 ms) — a deterministic gate, no fixed sleep. */
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// PF-7c (full-audit 2026-07-10, closes carried-forward PERF-5): the store used to notify per token
// with a freshly mapped `turns` array — every token re-rendered the Images screen. Tokens now
// buffer through a 40 ms flush (the ChatScreen STREAM_FLUSH_MS precedent): a burst inside one
// window produces ONE snapshot rebuild + ONE notify, and the settle paths flush FIRST so no
// token is ever lost.
describe('visionSession — PF-7c batched token flush', () => {
  function wireStubs(): { tokenCbs: Record<string, (t: string) => void>; doneCbs: Record<string, (j: unknown) => void> } {
    const tokenCbs: Record<string, (t: string) => void> = {}
    const doneCbs: Record<string, (j: unknown) => void> = {}
    stubApi({
      imageAnalyze: vi.fn(async () => ({ jobId: 'j1', state: 'starting' })),
      onImageToken: vi.fn((id: string, cb: (t: string) => void) => {
        tokenCbs[id] = cb
        return () => delete tokenCbs[id]
      }),
      onImageDone: vi.fn((id: string, cb: (j: unknown) => void) => {
        doneCbs[id] = cb
        return () => delete doneCbs[id]
      }),
      onImageError: vi.fn(() => () => {})
    } as never)
    return { tokenCbs, doneCbs }
  }

  it('a token burst inside one flush window produces exactly ONE notify', async () => {
    vi.useFakeTimers()
    try {
      const { tokenCbs } = wireStubs()
      selectImage(img('a.png'))
      await analyze('question')
      const listener = vi.fn()
      const unsub = subscribeVisionSession(listener)
      const before = getVisionSession()

      for (const tk of ['a', 'b', 'c', 'd', 'e']) tokenCbs.j1?.(tk)
      // Buffered — nothing applied, the snapshot identity is untouched mid-window.
      expect(listener).not.toHaveBeenCalled()
      expect(getVisionSession()).toBe(before)

      await vi.advanceTimersByTimeAsync(40)
      expect(listener).toHaveBeenCalledTimes(1) // ONE batched notify for the whole burst
      expect(getVisionSession().turns[0].answer).toBe('abcde')
      expect(getVisionSession().turns[0].state).toBe('analyzing')
      unsub()
    } finally {
      vi.useRealTimers()
    }
  })

  it('done flushes the buffer first — the accumulated-answer fallback sees every token', async () => {
    const { tokenCbs, doneCbs } = wireStubs()
    selectImage(img('a.png'))
    await analyze('question')

    tokenCbs.j1?.('partial ')
    tokenCbs.j1?.('answer')
    // Done arrives INSIDE the flush window carrying no full text — the fallback reads the turn.
    doneCbs.j1?.({ jobId: 'j1', state: 'done' })
    expect(getVisionSession().turns[0].answer).toBe('partial answer')
    expect(getVisionSession().turns[0].state).toBe('done')
    expect(getVisionSession().analyzing).toBe(false)
  })

  it('Stop flushes the buffer first — tokens already received land in the stopped turn', async () => {
    const { tokenCbs } = wireStubs()
    selectImage(img('a.png'))
    await analyze('question')

    tokenCbs.j1?.('kept ')
    tokenCbs.j1?.('text')
    stopActive() // inside the flush window
    expect(getVisionSession().turns[0].answer).toBe('kept text')
    expect(getVisionSession().turns[0].state).toBe('cancelled')
  })
})
