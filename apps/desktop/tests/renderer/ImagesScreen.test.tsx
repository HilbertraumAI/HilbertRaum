// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImagesScreen } from '../../src/renderer/screens/ImagesScreen'
import { ToastProvider } from '../../src/renderer/components'
import { resetVisionSessionForTests } from '../../src/renderer/lib/visionSession'
import { __turnRowRenderCounts } from '../../src/renderer/images'
import type { DecodedImage, DecodeImage } from '../../src/renderer/images'
import type { ImageJob, VisionStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

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

/** Stream-driving stubs: capture the subscriber callbacks so a test can push tokens/done/error. */
function streamStubs(): {
  token: { fn?: (t: string) => void }
  done: { fn?: (j: ImageJob) => void }
  error: { fn?: (j: ImageJob) => void }
  api: Record<string, unknown>
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
    stubApi({ imageGetStatus: vi.fn(async () => ({ available: false, reason: 'no-model' })) } as never)
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
    stubApi({ imageGetStatus: vi.fn(async () => ({ available: false, reason: 'no-runtime' })) } as never)
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    expect(
      await screen.findByText('Image understanding needs the AI engine installed first.')
    ).toBeInTheDocument()
  })
})

describe('ImagesScreen — empty / selected (§5.2/§5.3)', () => {
  it('shows the drop zone when a model is available and no image is selected', async () => {
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE) } as never)
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    expect(await screen.findByRole('button', { name: 'Drop an image here' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'or choose an image' })).toBeInTheDocument()
  })

  it('decodes a picked image into the two-pane workspace (preview + composer + chips)', async () => {
    const user = userEvent.setup()
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE), ...pickStubs() } as never)
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

  it('rejects a multi-drop with a friendly banner rather than taking the first file', async () => {
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE) } as never)
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    const zone = await screen.findByRole('button', { name: 'Drop an image here' })
    const file = (n: string) => new File([new Uint8Array([1])], n, { type: 'image/png' })
    await act(async () => {
      fireDrop(zone, [file('a.png'), file('b.png')])
    })
    expect(await screen.findByText('Drop one image at a time.')).toBeInTheDocument()
    // Still on the drop zone — no image was taken.
    expect(screen.getByRole('button', { name: 'Drop an image here' })).toBeInTheDocument()
  })
})

describe('ImagesScreen — chips + analyze streaming (§5.4/§5.5)', () => {
  it('a chip fills the composer (no auto-send)', async () => {
    const user = userEvent.setup()
    stubApi({ imageGetStatus: vi.fn(async () => AVAILABLE), ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    expect(screen.getByRole('button', { name: 'Drop an image here' })).toBeInTheDocument()
  })

  it('selecting a new image mid-analysis cancels the in-flight job and resets the thread', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() } as never)
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.token.fn).toBeDefined())
    await act(async () => s.token.fn?.('Partial…'))
    // PF-7c: tokens land on the store's 40 ms batch flush, not synchronously — findByText waits.
    expect(await screen.findByText(/Partial…/)).toBeInTheDocument()

    // Replace the image while the analyze is still running.
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(s.cancel).toHaveBeenCalledWith('j1'))
    // The previous turn is gone — the thread reset for the new image.
    await waitFor(() => expect(screen.queryByText(/Partial…/)).not.toBeInTheDocument())
  })

  it('Stop cancels the active job and marks the turn stopped', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
    stubApi({ ...s.api, ...pickStubs() } as never)
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
  const summary = (over?: Record<string, unknown>) => ({
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
    } as never)
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
    } as never)
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
    } as never)
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)

    await screen.findByText('receipt.png')
    // The row's Delete opens a ConfirmDialog; confirm inside the dialog (avoids the row button).
    await user.click(screen.getByRole('button', { name: 'Delete' }))
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
    } as never)
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />
      </ToastProvider>
    )

    await screen.findByText('receipt.png')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
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
    } as never)
    render(<ImagesScreen onNavigate={vi.fn()} decodeImpl={fakeDecode} />)

    await user.click(await screen.findByText('receipt.png'))
    // TEETH: pre-fix this was a silent no-op (the vanished-entry path) — no banner ever appeared.
    expect(
      await screen.findByText("That analysis couldn't be opened. Try again.")
    ).toBeInTheDocument()
  })
})

describe('ImagesScreen — copy feedback (full-audit 2026-07-11 CODE-36)', () => {
  it('a failed copy toasts the failure instead of staying silent', async () => {
    const user = userEvent.setup()
    const s = streamStubs()
    s.copyToClipboard.mockResolvedValue(false) // main refused the write
    stubApi({ ...s.api, ...pickStubs() } as never)
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
function fireDrop(el: Element, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files } })
  el.dispatchEvent(event)
}
