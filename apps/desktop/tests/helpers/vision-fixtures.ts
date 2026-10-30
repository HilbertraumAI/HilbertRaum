import { vi, type Mock } from 'vitest'
import type { PreloadApi } from '../../src/preload'
import type { DecodedImage } from '../../src/renderer/images/decode'
import type { SelectedImage } from '../../src/renderer/lib/visionSession'
import type {
  ImageAnalyzeRequest,
  ImageJob,
  ImageSessionDetail,
  ImageSessionSummary,
  VisionErrorCode,
  VisionStatus
} from '../../src/shared/types'

// Typed vision fixtures for the Images renderer suites (chat-ui campaign, lane D). Replaces the local copies
// ImagesScreen.test.tsx and visionSession.test.ts carried: `decoded` / `img`, `AVAILABLE`, `streamStubs`
// (one captured listener per kind) / `wireStubs` + three hand-rolled stub blocks (a per-jobId `Record`),
// `pickStubs`, `summary` and the `ImageSessionDetail` literal written four times.
//
// Rules:
//  - The event shapes are the ones main sends. `imageAnalyze` answers `{ state: 'queued' }` (vision/index.ts
//    `analyze`, its initial job; registerImagesIpc adds `sessionId`), never 'starting'. A failure is an ERROR
//    event `{ state: 'failed', error: code }` (vision/index.ts `fail()`), including an empty answer
//    ('emptyResponse'); `done` carries the answer. `done(jobId)` without an answer is a shape main never
//    sends: only the store's defensive rows use it.
//  - A fake event must reach a live listener: `token` / `done` / `error` throw when nothing is subscribed for
//    that job. Gate a screen row on `wired(jobId)` (the store subscribes after the `imageAnalyze` round-trip).
//  - The emitters do not wrap in `act`: a screen row wraps them (`await act(async () => s.token('j1', 'x'))`).

/** An available vision model. */
export const VISION_AVAILABLE: VisionStatus = {
  available: true,
  modelId: 'qwen2.5-vl-3b',
  modelDisplayName: 'Qwen2.5-VL 3B'
}

/** A decoded 120×90 PNG of 4 bytes — the screen shows "PNG · 4 B · 120×90". */
export function decodedImage(over: Partial<DecodedImage> = {}): DecodedImage {
  return {
    bytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
    width: 120,
    height: 90,
    ...over
  }
}

/** A loaded image for the vision store (`selectImage`). */
export function selectedImage(name = 'a.png', over: Partial<SelectedImage> = {}): SelectedImage {
  return { decoded: decodedImage(), name, sizeBytes: 4, ...over }
}

/** One saved history entry `s1` / `receipt.png` (two questions). */
export function imageSessionSummary(over: Partial<ImageSessionSummary> = {}): ImageSessionSummary {
  return {
    id: 's1',
    title: 'receipt.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    width: 120,
    height: 90,
    turnCount: 2,
    firstQuestion: 'What is this?',
    createdAt: '2026-06-20T00:00:00Z',
    updatedAt: '2026-06-20T00:00:00Z',
    ...over
  }
}

/** The reopened `s1`: the decrypted bytes and one stored turn answered "A receipt.". */
export function imageSessionDetail(over: Partial<ImageSessionDetail> = {}): ImageSessionDetail {
  return {
    id: 's1',
    title: 'receipt.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    width: 120,
    height: 90,
    imageBytes: new Uint8Array([1, 2, 3, 4]),
    turns: [{ id: 't1', question: 'What is this?', answer: 'A receipt.', createdAt: '2026-06-20T00:00:00Z' }],
    createdAt: '2026-06-20T00:00:00Z',
    updatedAt: '2026-06-20T00:00:00Z',
    ...over
  }
}

/** The picker path (D2): `imageChooseImage` hands back a token for `name`, `imageReadBytes` its 4 bytes. */
export function pickedImage(name = 'receipt.png'): {
  imageChooseImage: Mock<PreloadApi['imageChooseImage']>
  imageReadBytes: Mock<PreloadApi['imageReadBytes']>
} {
  return {
    imageChooseImage: vi.fn<PreloadApi['imageChooseImage']>(async () => ({ token: `tok-${name}`, name, sizeBytes: 4 })),
    imageReadBytes: vi.fn<PreloadApi['imageReadBytes']>(async () => new Uint8Array([1, 2, 3, 4]))
  }
}

/** What a mounted ImagesScreen reads: the vision status (available) and an empty history. `over` spreads last. */
export function visionScreenStubs(over: Partial<PreloadApi> = {}): Partial<PreloadApi> {
  return {
    imageGetStatus: vi.fn<PreloadApi['imageGetStatus']>(async () => VISION_AVAILABLE),
    listImageSessions: vi.fn<PreloadApi['listImageSessions']>(async () => []),
    ...over
  }
}

/** The fake analyze stream: spread `api` into stubApi, then emit into the job's live listeners. */
export interface VisionStream {
  /** `visionScreenStubs()` + imageAnalyze, imageCancel, copyToClipboard and the three onImage* subscriptions. */
  api: Partial<PreloadApi>
  analyze: Mock<PreloadApi['imageAnalyze']>
  cancel: Mock<PreloadApi['imageCancel']>
  copyToClipboard: Mock<PreloadApi['copyToClipboard']>
  /** One answer token for `jobId`. */
  token(jobId: string, t: string): void
  /** `{ jobId, state: 'done', answer, sessionId: null }`; with no `answer` the key is absent (defensive rows only). */
  done(jobId: string, answer?: string): void
  /** `{ jobId, state: 'failed', error: code, sessionId: null }`: main's `fail()`. */
  error(jobId: string, code: VisionErrorCode): void
  /** True while the store has the job's token, done and error listeners subscribed. */
  wired(jobId: string): boolean
}

/** One onImage* channel: the listener per job id. An unsubscribe removes only its own listener. */
function imageChannel<T>(kind: string): {
  subscribe: (jobId: string, cb: (payload: T) => void) => () => void
  emit: (jobId: string, payload: T) => void
  live: (jobId: string) => boolean
} {
  const listeners = new Map<string, (payload: T) => void>()
  return {
    subscribe: (jobId, cb) => {
      listeners.set(jobId, cb)
      return () => {
        if (listeners.get(jobId) === cb) listeners.delete(jobId)
      }
    },
    emit: (jobId, payload) => {
      const cb = listeners.get(jobId)
      if (cb == null) throw new Error(`no live onImage${kind} listener for ${jobId}`)
      cb(payload)
    },
    live: (jobId) => listeners.has(jobId)
  }
}

/**
 * Drive one analysis the way main does. `analyze` replaces the `imageAnalyze` answer (default: job `j1`,
 * queued) — park it with a never-settling promise for the start round-trip window.
 */
export function visionStream(opts: { analyze?: (req: ImageAnalyzeRequest) => Promise<ImageJob> } = {}): VisionStream {
  const token = imageChannel<string>('Token')
  const done = imageChannel<ImageJob>('Done')
  const error = imageChannel<ImageJob>('Error')
  const analyze = vi.fn<PreloadApi['imageAnalyze']>(
    opts.analyze ?? (async () => ({ jobId: 'j1', state: 'queued', sessionId: null }))
  )
  const cancel = vi.fn<PreloadApi['imageCancel']>(async (jobId) => ({ jobId, state: 'cancelled' }))
  const copyToClipboard = vi.fn<PreloadApi['copyToClipboard']>(async () => true)
  return {
    api: {
      ...visionScreenStubs(),
      imageAnalyze: analyze,
      imageCancel: cancel,
      copyToClipboard,
      onImageToken: vi.fn<PreloadApi['onImageToken']>(token.subscribe),
      onImageDone: vi.fn<PreloadApi['onImageDone']>(done.subscribe),
      onImageError: vi.fn<PreloadApi['onImageError']>(error.subscribe)
    },
    analyze,
    cancel,
    copyToClipboard,
    token: token.emit,
    done: (jobId, answer) =>
      done.emit(
        jobId,
        answer === undefined ? { jobId, state: 'done', sessionId: null } : { jobId, state: 'done', answer, sessionId: null }
      ),
    error: (jobId, code) => error.emit(jobId, { jobId, state: 'failed', error: code, sessionId: null }),
    wired: (jobId) => token.live(jobId) && done.live(jobId) && error.live(jobId)
  }
}
