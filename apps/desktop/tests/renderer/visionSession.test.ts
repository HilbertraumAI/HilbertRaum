// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  analyze,
  selectImage,
  getVisionSession,
  resetVisionSessionForTests,
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

    // The live job is B, and its stream is the one wired — a token lands on B's single turn.
    expect(getVisionSession().activeJobId).toBe('jobB')
    tokenCbs.jobB?.('hello')
    const { turns } = getVisionSession()
    expect(turns).toHaveLength(1)
    expect(turns[0].question).toBe('question B')
    expect(turns[0].answer).toBe('hello')
  })
})
