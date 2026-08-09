// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImagesScreen } from '../../src/renderer/screens/ImagesScreen'
import { ToastProvider } from '../../src/renderer/components'
import { resetVisionSessionForTests } from '../../src/renderer/lib/visionSession'
import { __turnRowRenderCounts } from '../../src/renderer/images'
import type { DecodedImage, DecodeImage } from '../../src/renderer/images'
import type {
  ImageJob,
  VisionStatus,
  VisionUnavailableReason,
  ImageSessionSummary,
  ImageSessionDetail
} from '../../src/shared/types'
import type { PreloadApi } from '../../src/preload'
import { stubApi } from '../helpers/renderer'

// F-41 (audit-2026-07-16): stub payloads are typed against the real PreloadApi bridge contract
// (no `as never` erasure). The status/history builders return the real shared types, and
// `streamStubs().api` is `Partial<PreloadApi>`, so a rename of any mocked method or of
// VisionStatus/ImageSession* reddens typecheck instead of drifting silently.

// Renderer test (jsdom + RTL) for the Images screen state machine (image-understanding §5.6,
// §17). The decode pipeline uses createImageBitmap/OffscreenCanvas which jsdom lacks, so a
// fake decode is injected via the `decodeImpl` seam. Streaming is driven by capturing the
// onImage* subscriber callbacks and invoking them, mirroring the Chat screen lifecycle.

// The active analysis lives in a module-level store (so it survives navigation); reset it between
// tests so a prior test's loaded image / thread doesn't leak into the next render.
afterEach(() => {
  cleanup()
  resetVisionSessionForTests()
})

function decoded(over?: Partial<DecodedImage>): DecodedImage {
  return {
    bytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
    width: 120,
    height: 90,
    ...over
  }
}

const fakeDecode: DecodeImage = async () => decoded()

const AVAILABLE: VisionStatus = {
  available: true,
  modelId: 'qwen2.5-vl-3b',
  modelDisplayName: 'Qwen2.5-VL 3B'
}

const unavailable = (reason: VisionUnavailableReason): VisionStatus => ({ available: false, reason })

/** Stream-driving stubs: capture the subscriber callbacks so a test can push tokens/done/error. */
function streamStubs(): {
  token: { fn?: (t: string) => void }
  done: { fn?: (j: ImageJob) => void }
  error: { fn?: (j: ImageJob) => void }
  api: Partial<PreloadApi>
  cancel: ReturnType<typeof vi.fn>
  copyToClipboard: ReturnType<typeof vi.fn>
} {
  const token: { fn?: (t: string) => void } = {}
  const done: { fn?: (j: ImageJob) => void } = {}
  const error: { fn?: (j: ImageJob) => void } = {}
  const cancel = vi.fn(async () => ({ jobId: 'j1', state: 'cancelled' }) as ImageJob)
  const copyToClipboard = vi.fn(async () => true)
  const api = {
    imageGetStatus: vi.fn(async () => AVAILABLE),
    imageAnalyze: vi.fn(async () => ({ jobId: 'j1', state: 'starting' }) as ImageJob),
    imageCancel: cancel,
    copyToClipboard,
    onImageToken: vi.fn((_id: string, cb: (t: string) => void) => {
      token.fn = cb
      return () => {}
    }),
    onImageDone: vi.fn((_id: string, cb: (j: ImageJob) => void) => {
      done.fn = cb
      return () => {}
    }),
    onImageError: vi.fn((_id: string, cb: (j: ImageJob) => void) => {
      error.fn = cb
      return () => {}
    })
  }
  return { token, done, error, api, cancel, copyToClipboard }
}

/** Choose-path stubs: the picker returns a token (D2); readBytes returns bytes; decode faked. */
function pickStubs(name = 'receipt.png') {
  return {
    imageChooseImage: vi.fn(async () => ({ token: `tok-${name}`, name, sizeBytes: 4 })),
    imageReadBytes: vi.fn(async () => new Uint8Array([1, 2, 3, 4]))
  }
}

async function selectImageViaPicker(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'or choose an image' }))
  await screen.findByText('receipt.png')
}

describe('ImagesScreen — availability (§5.6)', () => {
  it('shows the reason-adaptive unavailable card and routes the CTA to AI Model', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    stubApi({ imageGetStatus: vi.fn(async () => unavailable('no-model')) })
    render(<ImagesScreen onNavigate={onNavigate} decodeImpl={fakeDecode} />)

    expect(
      await screen.findByText('Image understanding needs a local vision model on this drive.')
    ).toBeInTheDocument()
    // The OCR pointer + the CTA to AI Model.
    expect(screen.getByText(/Make searchable \(OCR\) under Documents/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go to AI Model' }))
    expect(onNavigate).toHaveBeenCalledWith('models')
  })

  it('adapts the note for the no-runtime reason', async () => {
    stubApi({ imageGetStatus: vi.fn(async () => unavailable('no-runtime')) })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    expect(
      await screen.findByText('Image understanding needs the AI engine installed first.')
    ).toBeInTheDocument()
  })
})

/** #161 (FE-6): the drop zone is a plain drag surface now (no button role) — find it by title. */
async function findImageZone(): Promise<HTMLElement> {
  const el = (await screen.findByText('Drop an image here')).closest('.image-dropzone')
  if (!(el instanceof HTMLElement)) throw new Error('drop zone not rendered')
  return el
}

describe('ImagesScreen — empty / selected (§5.2/§5.3)', () => {
  it('shows the drop zone when a model is available and no image is selected', async () => {
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE) })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    expect(await findImageZone()).toBeInTheDocument()
    // The inner Button is THE single accessible control (FE-6 — no nested interactive).
    expect(screen.getByRole('button', { name: 'or choose an image' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Drop an image here' })).toBeNull()
  })

  it('decodes a picked image into the two-pane workspace (preview + composer + chips)', async () => {
    const user = userEvent.setup()
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE), ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)

    // Preview pane: image + filename + meta line.
    expect(screen.getByAltText('Selected image')).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(screen.getByText('receipt.png')).toBeInTheDocument()
    expect(screen.getByText('PNG · 4 B · 120×90')).toBeInTheDocument()
    // Work pane: composer + suggestion chips.
    expect(screen.getByPlaceholderText('Ask about this image…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Summarize this image' })).toBeInTheDocument()
  })

  // #124: WEBP is an accepted INTAKE format (normalized to PNG inside decode — faked here);
  // HEIC stays unsupported but gets its specific "convert to JPEG" copy, not the generic banner.
  it('accepts a dropped WEBP into the decode pipeline (#124)', async () => {
    const decodeSpy = vi.fn(fakeDecode)
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE) })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={decodeSpy} />)
    const zone = await findImageZone()
    const webp = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'shot.webp', {
      type: 'image/webp'
    })
    await act(async () => {
      fireDrop(zone, [webp])
    })
    await screen.findByText('shot.webp') // reached the workspace — not rejected as unsupported
    expect(decodeSpy).toHaveBeenCalledWith(expect.anything(), 'image/webp')
  })

  it('a dropped HEIC shows the specific convert-to-JPEG copy (#124)', async () => {
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE) })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    const zone = await findImageZone()
    const heic = new File([new Uint8Array([1])], 'IMG_0001.HEIC', { type: '' })
    await act(async () => {
      fireDrop(zone, [heic])
    })
    expect(
      await screen.findByText("iPhone HEIC photos aren't supported yet. Convert the photo to JPEG first.")
    ).toBeInTheDocument()
    // Still on the drop zone — nothing was taken.
    expect(screen.getByText('Drop an image here')).toBeInTheDocument()
  })

  it('rejects a multi-drop with a friendly banner rather than taking the first file', async () => {
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE) })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    const zone = await findImageZone()
    const file = (n: string) => new File([new Uint8Array([1])], n, { type: 'image/png' })
    await act(async () => {
      fireDrop(zone, [file('a.png'), file('b.png')])
    })
    expect(await screen.findByText('Drop one image at a time.')).toBeInTheDocument()
    // Still on the drop zone — no image was taken.
    expect(screen.getByText('Drop an image here')).toBeInTheDocument()
  })
})

describe('ImagesScreen — chips + analyze streaming (§5.4/§5.5)', () => {
  it('a chip fills the composer (no auto-send)', async () => {
    const user = userEvent.setup()
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE), ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)

    await user.click(screen.getByRole('button', { name: 'Extract visible text' }))
    const box = screen.getByPlaceholderText('Ask about this image…') as HTMLTextAreaElement
    expect(box.value).toBe(
      'Extract the visible text you can read. Preserve line breaks where helpful. Say if any text is unclear.'
    )
  })

  it('streams an answer: starting → tokens → done with Copy / Try again', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)

    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))

    // The calm starting line + a Stop, until the first token arrives.
    expect(await screen.findByText('Starting the vision model…')).toBeInTheDocument()
    await waitFor(() => expect(s.token.fn).toBeDefined())

    await act(async () => s.token.fn?.('It is '))
    await act(async () => s.token.fn?.('a receipt.'))
    // PF-7c: tokens land on the store's 40 ms batch flush, not synchronously — findByText waits.
    expect(await screen.findByText(/It is a receipt\./)).toBeInTheDocument()

    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'It is a receipt.' }))
    expect(screen.getByText('Generated locally from the selected image.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('Copy uses the main-process clipboard (not navigator.clipboard, which the renderer denies)', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.done.fn).toBeDefined())
    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'It is a receipt.' }))

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(s.copyToClipboard).toHaveBeenCalledWith('It is a receipt.')
  })

  it('shows a friendly runtime-failure banner (never raw output)', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)

    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.error.fn).toBeDefined())
    await act(async () => s.error.fn?.({ jobId: 'j1', state: 'failed', error: 'runtimeFailed' }))
    expect(
      screen.getByText("The vision model couldn't start. Try again, or pick another model.")
    ).toBeInTheDocument()
  })

  // F4 (full audit 2026-06-30): vision is one-at-a-time. A prior turn's "Try again" used to stay
  // clickable while a different turn streamed, and analyze() then early-returned silently on the
  // busy job — the click vanished with no answer and no feedback. The trigger must now disable.
  it('disables a prior turn’s "Try again" while another analysis is in flight (F4)', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)

    // First analysis → done: its turn shows an ENABLED "Try again".
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.done.fn).toBeDefined())
    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'A receipt.' }))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()

    // Start a SECOND analysis (the composer is free again). The prior turn's "Try again" must go
    // disabled — the click can no longer be silently swallowed by the busy backend.
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'And this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled())
  })

  // PF-7c (full-audit 2026-07-10): stable handler identities (useEventCallback) + the token batch
  // flush mean a SETTLED turn's memoized row no longer re-renders on every stream flush of a
  // sibling turn — the `__docRowRenderCounts` oracle pattern, applied to TurnRow.
  it('a settled TurnRow does not re-render while a new turn streams (PF-7c)', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)

    // First turn settles.
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.done.fn).toBeDefined())
    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'A receipt.' }))
    await screen.findByText('A receipt.')

    // Second turn starts streaming. Measure AFTER its first flush landed — the busy flip that
    // legitimately re-renders every row (it disables the settled row's "Try again") is behind us.
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'And this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.token.fn).toBeDefined())
    await act(async () => s.token.fn?.('One'))
    await screen.findByText(/One/)
    const before = new Map(__turnRowRenderCounts)

    await act(async () => s.token.fn?.(' two'))
    await screen.findByText(/One two/)
    const delta = (id: string): number =>
      (__turnRowRenderCounts.get(id) ?? 0) - (before.get(id) ?? 0)
    expect(delta('img-turn-1')).toBe(0) // the settled row's memo held through the flush
    expect(delta('img-turn-2')).toBeGreaterThan(0) // the streaming row is the only one updating
  })

  it('maps an empty model response to the friendly empty-response copy', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'q')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.done.fn).toBeDefined())
    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: '   ' }))
    expect(
      screen.getByText('No answer came back for that image. Try rephrasing your question.')
    ).toBeInTheDocument()
  })
})

describe('ImagesScreen — reset + cancel (§5.6)', () => {
  it('Remove clears the image and the thread (back to the drop zone)', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'q')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.done.fn).toBeDefined())
    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'Answer.' }))
    expect(screen.getByText('Answer.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    // The thread + preview are gone; the drop zone is back.
    expect(screen.queryByText('Answer.')).not.toBeInTheDocument()
    expect(screen.getByText('Drop an image here')).toBeInTheDocument()
  })

  it('Replace is disabled mid-analysis (DOC-12); after it settles, replacing resets the thread', async () => {
    // DOC-12 (#150): this test used to pin the OLD behavior — Replace mid-analysis opened the
    // picker and cancelled the streaming answer without confirmation. Replace now gates on
    // `decoding || analyzing` like the landing drop zone; the reset-on-replace behavior is
    // asserted for the settled state (the store's supersede/cancel invariant stays covered in
    // visionSession.test.ts).
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.token.fn).toBeDefined())
    await act(async () => s.token.fn?.('Partial…'))
    // PF-7c: tokens land on the store's 40 ms batch flush, not synchronously — findByText waits.
    expect(await screen.findByText(/Partial…/)).toBeInTheDocument()

    // Mid-analysis the Replace affordance is gated off.
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled()

    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'Partial… done.' }))
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    // The previous turn is gone — the thread reset for the new image; nothing to cancel.
    await waitFor(() => expect(screen.queryByText(/Partial…/)).not.toBeInTheDocument())
    expect(s.cancel).not.toHaveBeenCalled()
  })

  it('Stop cancels the active job and marks the turn stopped', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'q')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.token.fn).toBeDefined())
    await act(async () => s.token.fn?.('Half'))

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(s.cancel).toHaveBeenCalledWith('j1')
    expect(await screen.findByText('Stopped.')).toBeInTheDocument()
  })
})

describe('ImagesScreen — survives navigation (running analysis recovery)', () => {
  it('lands on the list with a running row after unmount + remount; clicking it shows the live stream', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    const { unmount } = render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.token.fn).toBeDefined())
    await act(async () => s.token.fn?.('Partial so far'))

    // Navigate away: the screen unmounts WITHOUT cancelling the in-flight job.
    unmount()
    expect(s.cancel).not.toHaveBeenCalled()

    // Come back: we land on the landing view (NOT the result view), and the running analysis is
    // surfaced as a row in the previous-results list.
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    expect(await screen.findByText('Analysis running…')).toBeInTheDocument()
    expect(screen.getByText('receipt.png')).toBeInTheDocument()
    // The upload is disabled while one runs (vision is one-at-a-time).
    expect(screen.getByRole('button', { name: 'or choose an image' })).toBeDisabled()

    // Clicking the running row opens the live detail view — the partial answer is intact.
    await user.click(screen.getByText('Analysis running…'))
    expect(await screen.findByText(/Partial so far/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    // The analysis completes, and the answer finalizes.
    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'Partial so far — done.' }))
    expect(await screen.findByText('Partial so far — done.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('Back returns to the list (analysis keeps running) without cancelling', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.token.fn).toBeDefined())
    await act(async () => s.token.fn?.('Half'))

    await user.click(screen.getByRole('button', { name: '‹ Back to analyses' }))
    // On the list: the job was NOT cancelled, and it shows as the running row + the busy hint.
    expect(s.cancel).not.toHaveBeenCalled()
    expect(await screen.findByText('Analysis running…')).toBeInTheDocument()
    expect(
      screen.getByText('An analysis is running. Wait for it to finish to start another.')
    ).toBeInTheDocument()
  })
})

describe('ImagesScreen — history (image-understanding history)', () => {
  const summary = (over?: Partial<ImageSessionSummary>): ImageSessionSummary => ({
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
  })

  it('lists saved analyses on the landing view (file name + question count)', async () => {
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions: vi.fn(async () => [summary()])
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    expect(await screen.findByText('History')).toBeInTheDocument()
    expect(await screen.findByText('receipt.png')).toBeInTheDocument()
    expect(screen.getByText('2 questions')).toBeInTheDocument()
  })

  it('opening a saved analysis decrypts the image and replays its turns', async () => {
    const getImageSession = vi.fn(async () => ({
      id: 's1',
      title: 'receipt.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      width: 120,
      height: 90,
      imageBytes: new Uint8Array([1, 2, 3, 4]),
      turns: [{ id: 't1', question: 'What is this?', answer: 'A receipt.', createdAt: '2026-06-20T00:00:00Z' }],
      createdAt: '2026-06-20T00:00:00Z',
      updatedAt: '2026-06-20T00:00:00Z'
    }))
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions: vi.fn(async () => [summary()]),
      getImageSession
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)

    await user.click(await screen.findByText('receipt.png'))
    expect(getImageSession).toHaveBeenCalledWith('s1')
    // The stored answer is replayed and the image is loaded into the workspace.
    expect(await screen.findByText('A receipt.')).toBeInTheDocument()
    expect(screen.getByAltText('Selected image')).toBeInTheDocument()
  })

  it('deleting a saved analysis confirms, calls deleteImageSession, and refreshes the list', async () => {
    const deleteImageSession = vi.fn(async () => {})
    let calls = 0
    const listImageSessions = vi.fn(async () => (calls++ === 0 ? [summary()] : []))
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions,
      deleteImageSession
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)

    await screen.findByText('receipt.png')
    // The row's Delete opens a ConfirmDialog; confirm inside the dialog (avoids the row button).
    await user.click(screen.getByRole('button', { name: 'Delete receipt.png' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteImageSession).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(screen.queryByText('receipt.png')).not.toBeInTheDocument())
  })

  // full-audit 2026-07-11 CODE-34: a FAILED delete used to fall through to the success toast
  // ("Removed from history") while the entry stayed in the list.
  it('a failed delete shows the failure banner and never the success toast (CODE-34)', async () => {
    const deleteImageSession = vi.fn(async () => {
      throw new Error('The workspace is locked. Unlock it to continue.')
    })
    const listImageSessions = vi.fn(async () => [summary()])
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions,
      deleteImageSession
    })
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />
      </ToastProvider>
    )

    await screen.findByText('receipt.png')
    await user.click(screen.getByRole('button', { name: 'Delete receipt.png' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // TEETH: pre-fix "Removed from history" toasted here despite the throw, and no failure showed.
    expect(
      await screen.findByText("That analysis couldn't be deleted. Try again.")
    ).toBeInTheDocument()
    expect(screen.queryByText('Removed from history')).not.toBeInTheDocument()
    // The entry is still listed — the list refresh reflects the true state.
    expect(screen.getByText('receipt.png')).toBeInTheDocument()
  })

  // full-audit 2026-07-11 CODE-36: a load FAILURE used to be indistinguishable from a vanished
  // entry (both fell into the silent list-resync no-op).
  it('a saved-analysis open FAILURE surfaces, distinct from a vanished entry (CODE-36)', async () => {
    const getImageSession = vi.fn(async () => {
      throw new Error('The workspace is locked. Unlock it to continue.')
    })
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions: vi.fn(async () => [summary()]),
      getImageSession
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)

    await user.click(await screen.findByText('receipt.png'))
    // TEETH: pre-fix this was a silent no-op (the vanished-entry path) — no banner ever appeared.
    expect(
      await screen.findByText("That analysis couldn't be opened. Try again.")
    ).toBeInTheDocument()
  })

  // #121: the stored bytes are ALREADY the pipeline's output (≤1536 px, re-encoded) — reopening
  // must not run them through decodeImage again (a no-op scale + a fresh JPEG q0.9 re-encode,
  // compounding generation loss into every reopened follow-up and defeating cache_prompt reuse).
  it('#121: reopening a stored entry bypasses the decode pipeline (stored bytes verbatim)', async () => {
    const decodeSpy = vi.fn(fakeDecode)
    const getImageSession = vi.fn(async (): Promise<ImageSessionDetail> => ({
      id: 's1',
      title: 'receipt.png',
      mimeType: 'image/jpeg',
      sizeBytes: 4,
      width: 800, // persisted dims ≤ the 1536 downscale target ⇒ no scaling needed
      height: 600,
      imageBytes: new Uint8Array([1, 2, 3, 4]),
      turns: [{ id: 't1', question: 'What is this?', answer: 'A receipt.', createdAt: '2026-06-20T00:00:00Z' }],
      createdAt: '2026-06-20T00:00:00Z',
      updatedAt: '2026-06-20T00:00:00Z'
    }))
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions: vi.fn(async () => [summary()]),
      getImageSession
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={decodeSpy} />)

    await user.click(await screen.findByText('receipt.png'))
    // TEETH: pre-fix the reopen ALWAYS re-decoded (decodeSpy called once per open).
    expect(await screen.findByText('A receipt.')).toBeInTheDocument()
    expect(screen.getByAltText('Selected image')).toBeInTheDocument()
    expect(decodeSpy).not.toHaveBeenCalled()
  })

  it('#121: a legacy entry without persisted dimensions still takes the full pipeline', async () => {
    const decodeSpy = vi.fn(fakeDecode)
    const getImageSession = vi.fn(async (): Promise<ImageSessionDetail> => ({
      id: 's1',
      title: 'receipt.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      width: null, // legacy row: dims never persisted ⇒ can't prove no-scale ⇒ full pipeline
      height: null,
      imageBytes: new Uint8Array([1, 2, 3, 4]),
      turns: [],
      createdAt: '2026-06-20T00:00:00Z',
      updatedAt: '2026-06-20T00:00:00Z'
    }))
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions: vi.fn(async () => [summary()]),
      getImageSession
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={decodeSpy} />)

    await user.click(await screen.findByText('receipt.png'))
    await waitFor(() => expect(decodeSpy).toHaveBeenCalledTimes(1))
  })

  it('#121: an oversized stored entry (dims above the downscale target) still re-decodes', async () => {
    const decodeSpy = vi.fn(fakeDecode)
    const getImageSession = vi.fn(async (): Promise<ImageSessionDetail> => ({
      id: 's1',
      title: 'big.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      width: 4000, // > 1536 ⇒ scaling IS needed ⇒ the fast path must not engage
      height: 3000,
      imageBytes: new Uint8Array([1, 2, 3, 4]),
      turns: [],
      createdAt: '2026-06-20T00:00:00Z',
      updatedAt: '2026-06-20T00:00:00Z'
    }))
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions: vi.fn(async () => [summary({ title: 'big.png' })]),
      getImageSession
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={decodeSpy} />)

    await user.click(await screen.findByText('big.png'))
    await waitFor(() => expect(decodeSpy).toHaveBeenCalledTimes(1))
  })

  // #122: the list says what it costs — per-entry stored size + the total in the header.
  it('#122: shows per-entry sizes and the total in the history header', async () => {
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions: vi.fn(async () => [
        summary({ id: 's1', title: 'a.png', sizeBytes: 2 * 1024 * 1024 }),
        summary({ id: 's2', title: 'b.png', sizeBytes: 1024 * 1024 })
      ])
    })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)

    expect(await screen.findByText('Total: 3.0 MB')).toBeInTheDocument()
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('1.0 MB')).toBeInTheDocument()
  })

  it('#122: Clear history confirms, calls clearImageSessions, refreshes the list, and toasts', async () => {
    const clearImageSessions = vi.fn(async () => 1)
    let calls = 0
    const listImageSessions = vi.fn(async () => (calls++ === 0 ? [summary()] : []))
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions,
      clearImageSessions
    })
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />
      </ToastProvider>
    )

    await screen.findByText('receipt.png')
    // The header action opens a ConfirmDialog (never browser confirm()); confirm inside it.
    await user.click(screen.getByRole('button', { name: 'Clear history' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Clear history' }))

    await waitFor(() => expect(clearImageSessions).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('receipt.png')).not.toBeInTheDocument())
    expect(await screen.findByText('Image history cleared')).toBeInTheDocument()
  })

  it('#122: a failed clear shows the failure banner and never the success toast (CODE-34 mirror)', async () => {
    const clearImageSessions = vi.fn(async () => {
      throw new Error('The workspace is locked. Unlock it to continue.')
    })
    const listImageSessions = vi.fn(async () => [summary()])
    const user = userEvent.setup()
    stubApi({
      imageGetStatus: vi.fn(async () => AVAILABLE),
      listImageSessions,
      clearImageSessions
    })
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />
      </ToastProvider>
    )

    await screen.findByText('receipt.png')
    await user.click(screen.getByRole('button', { name: 'Clear history' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Clear history' }))

    expect(await screen.findByText("The history couldn't be cleared. Try again.")).toBeInTheDocument()
    expect(screen.queryByText('Image history cleared')).not.toBeInTheDocument()
    // The entry is still listed — the list refresh reflects the true state.
    expect(screen.getByText('receipt.png')).toBeInTheDocument()
  })
})

describe('ImagesScreen — copy feedback (full-audit 2026-07-11 CODE-36)', () => {
  it('a failed copy toasts the failure instead of staying silent', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    s.copyToClipboard.mockResolvedValue(false) // main refused the write
    stubApi({ ...s.api, ...pickStubs() })
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />
      </ToastProvider>
    )
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'q')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.done.fn).toBeDefined())
    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'Answer.' }))

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    // TEETH: pre-fix a refused copy gave NO feedback at all (the `if (ok)` gate).
    expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument()
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })
})

// Minimal drag-drop event with a files-bearing dataTransfer (jsdom has no real DataTransfer).
// Carries `types: ['Files']` — DOC-3 (#143): the drop zone now accepts only real FILE drags
// (the TranslateDropZone L8 pattern), exactly what a native OS file drop reports.
function fireDrop(el: Element, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  el.dispatchEvent(event)
}

// DOC-12 + DOC-13 (frontend audit 2026-08-09, #150 — #143 companions).
describe('ImagesScreen — analysis-window guards (DOC-12/DOC-13)', () => {
  it('DOC-12: Replace and Remove are disabled while an analysis streams (like the landing zone)', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByText('Starting the vision model…')

    // Pre-fix Replace gated only on `decoding`: a stray click mid-analysis opened the picker
    // and cancelled the streaming answer without confirmation.
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()

    await act(async () => s.done.fn?.({ jobId: 'j1', state: 'done', answer: 'A receipt.' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace' })).toBeEnabled())
  })

  it('DOC-13: a busy-refused Ask restores the typed question instead of discarding it', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() })
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)

    const box = screen.getByPlaceholderText('Ask about this image…') as HTMLTextAreaElement
    await user.type(box, 'Which totals are visible?')
    // Two submits in the same flush — the F4 window where a click reaches onSend before React
    // re-renders the disabled composer (one act() so the disable can't land in between). The
    // second analyze is store-refused as 'busy'.
    const ask = screen.getByRole('button', { name: 'Ask' })
    await act(async () => {
      fireEvent.click(ask)
      fireEvent.click(ask)
    })

    // Pre-fix the second submit's optimistic clear discarded the question outright. Now the
    // refused draft comes back, and the friendly busy banner explains why.
    await waitFor(() => expect(box.value).toBe('Which totals are visible?'))
    expect(await screen.findByText('Working on the previous question…')).toBeInTheDocument()
  })
})
