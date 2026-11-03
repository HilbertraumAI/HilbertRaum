// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImagesScreen } from '../../src/renderer/screens/ImagesScreen'
import { ToastProvider } from '../../src/renderer/components'
import { clearVisionSession, getVisionSession } from '../../src/renderer/lib/visionSession'
import { decodeImage, DOWNSCALE_TARGET, ImageDecodeError, MAX_IMAGE_BYTES } from '../../src/renderer/images/decode'
import type { PreloadApi } from '../../src/preload'
import type { ImageSessionSummary, VisionStatus, VisionUnavailableReason } from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { dropFiles } from '../helpers/drop'
import {
  decodedImage,
  imageSessionDetail,
  imageSessionSummary,
  pickedImage,
  VISION_AVAILABLE,
  visionScreenStubs,
  visionStream,
  type VisionStream
} from '../helpers/vision-fixtures'
import { t } from '../../src/shared/i18n'

// PF-7c: count TurnRow renders test-side — production's memo object, inner component wrapped (no src seam).
const turnRenders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../src/renderer/images/TurnRow', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/renderer/images/TurnRow')>()
  const { countMemoRenders } = await import('../helpers/render-counter')
  return { ...m, TurnRow: countMemoRenders(m.TurnRow, (p) => p.turn.id, turnRenders) }
})

// The decode module is replaced with `vi.mock` (jsdom has no createImageBitmap/OffscreenCanvas); decode.test.ts
// runs the real pipeline. `images/index.ts` re-exports `./decode`, so the screen receives this mock, while
// `blobToDataUrl`, `DOWNSCALE_TARGET` and the pure intake helpers stay real.
vi.mock('../../src/renderer/images/decode', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/renderer/images/decode')>()
  return { ...m, decodeImage: vi.fn(m.decodeImage) }
})
const decodeMock = vi.mocked(decodeImage)
beforeEach(() => {
  decodeMock.mockReset()
  decodeMock.mockImplementation(async () => decodedImage())
})

// F-41 (audit-2026-07-16): stub payloads are typed against the real PreloadApi bridge contract
// (no `as never` erasure). The status/history builders in tests/helpers/vision-fixtures.ts return the
// real shared types, and `visionStream().api` is `Partial<PreloadApi>`, so a rename of any mocked method
// or of VisionStatus/ImageSession* reddens typecheck instead of drifting silently.

// Renderer test (jsdom + RTL) for the Images screen state machine (image-understanding §5.6,
// §17). Streaming is driven through `visionStream()`: it records the onImage* subscriber per job
// and emits main's event shapes into them, mirroring the Chat screen lifecycle.

// The active analysis lives in a module-level store (so it survives navigation); drop it after each
// test with the production purge `clearVisionSession()`, after RTL `cleanup()`.
afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    clearVisionSession()
  }
})

const unavailable = (reason: VisionUnavailableReason): VisionStatus => ({ available: false, reason })

async function selectImageViaPicker(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'or choose an image' }))
  await screen.findByText('receipt.png')
}

describe('ImagesScreen — availability (§5.6)', () => {
  // #539: one target for all three reasons — with the engine missing its banner leads that view,
  // with an engine too old the vision model's row says so.
  it.each([
    ['no-model', 'images.avail.noModel'],
    ['no-runtime', 'images.avail.noRuntime'],
    ['incompatible', 'images.avail.incompatible']
  ] as const)('the %s card shows its note, the OCR pointer, and a CTA to the vision model (#539)', async (reason, noteKey) => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    stubApi(visionScreenStubs({ imageGetStatus: vi.fn(async () => unavailable(reason)) }))
    render(<ImagesScreen onNavigate={onNavigate} />)

    expect(await screen.findByText(t('en', noteKey))).toBeInTheDocument()
    expect(screen.getByText(t('en', 'images.avail.ocrPointer'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: t('en', 'images.avail.cta') }))
    expect(onNavigate).toHaveBeenCalledWith('models:images')
  })

  // #743: the status is read on mount and again whenever the window regains focus, so a vision model that
  // landed while the screen stayed open opens the drop zone without a remount.
  it('re-reads the vision status on window focus: a model that landed meanwhile opens the drop zone (#743)', async () => {
    const imageGetStatus = vi.fn(async (): Promise<VisionStatus> => unavailable('no-model'))
    stubApi(visionScreenStubs({ imageGetStatus }))
    render(<ImagesScreen onNavigate={vi.fn()} />)
    expect(await screen.findByText(t('en', 'images.avail.noModel'))).toBeInTheDocument()

    imageGetStatus.mockImplementation(async () => VISION_AVAILABLE)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await findImageZone()).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'images.avail.noModel'))).not.toBeInTheDocument()
  })
})

/** #161 (FE-6): the drop zone is a plain drag surface now (no button role) — find it by title. */
async function findImageZone(): Promise<HTMLElement> {
  const el = (await screen.findByText('Drop an image here')).closest('.image-dropzone')
  if (!(el instanceof HTMLElement)) throw new Error('drop zone not rendered')
  return el
}

describe('ImagesScreen — empty / selected (§5.2/§5.3)', () => {
  it('shows the drop zone when a model is available and no image is selected (the OCR pointer stays, #539)', async () => {
    stubApi(visionScreenStubs())
    render(<ImagesScreen onNavigate={vi.fn()} />)
    expect(await findImageZone()).toBeInTheDocument()
    // The inner Button is THE single accessible control (FE-6 — no nested interactive).
    expect(screen.getByRole('button', { name: 'or choose an image' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Drop an image here' })).toBeNull()
    // #539: the OCR pointer stays under the drop zone once the vision model is installed.
    expect(screen.getByText(t('en', 'images.avail.ocrPointer'))).toBeVisible()
  })

  it('decodes a picked image into the two-pane workspace (preview + composer + chips)', async () => {
    const user = userEvent.setup()
    stubApi(visionScreenStubs(pickedImage()))
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)

    // Preview pane: image + filename + meta line.
    expect(screen.getByAltText('Selected image')).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(screen.getByText('receipt.png')).toBeInTheDocument()
    expect(screen.getByText('PNG · 4 B · 120×90')).toBeInTheDocument()
    // Work pane: composer + suggestion chips.
    expect(screen.getByPlaceholderText('Ask about this image…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Summarize this image' })).toBeInTheDocument()
  })

  // #124: WEBP is an accepted INTAKE format (normalized to PNG inside decode — mocked here);
  // HEIC stays unsupported but gets its specific "convert to JPEG" copy, not the generic banner.
  it('accepts a dropped WEBP into the decode pipeline (#124)', async () => {
    stubApi(visionScreenStubs())
    render(<ImagesScreen onNavigate={vi.fn()} />)
    const zone = await findImageZone()
    const webp = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'shot.webp', {
      type: 'image/webp'
    })
    await act(async () => {
      dropFiles(zone, [webp])
    })
    await screen.findByText('shot.webp') // reached the workspace — not rejected as unsupported
    expect(decodeMock).toHaveBeenCalledWith(expect.anything(), 'image/webp')
  })

  it('a dropped HEIC shows the specific convert-to-JPEG copy (#124)', async () => {
    stubApi(visionScreenStubs())
    render(<ImagesScreen onNavigate={vi.fn()} />)
    const zone = await findImageZone()
    const heic = new File([new Uint8Array([1])], 'IMG_0001.HEIC', { type: '' })
    await act(async () => {
      dropFiles(zone, [heic])
    })
    expect(
      await screen.findByText("iPhone HEIC photos aren't supported yet. Convert the photo to JPEG first.")
    ).toBeInTheDocument()
    // Still on the drop zone — nothing was taken.
    expect(screen.getByText('Drop an image here')).toBeInTheDocument()
  })

  // #539: a PDF is never taken here (and never imported from here), but it is named: the banner
  // points a scanned PDF to Make searchable (OCR), with a button to Documents.
  const PDF_COPY = t('en', 'images.err.pdf')

  it.each([
    ['by extension', new File([new Uint8Array([1])], 'Scan 2026.PDF', { type: '' })],
    ['by type', new File([new Uint8Array([1])], 'scan', { type: 'application/pdf' })]
  ])('a dropped PDF (%s) points to OCR in Documents, with a button there', async (_how, pdf) => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    stubApi(visionScreenStubs({ importDocuments: vi.fn() }))
    render(<ImagesScreen onNavigate={onNavigate} />)
    const zone = await findImageZone()
    await act(async () => {
      dropFiles(zone, [pdf])
    })
    expect(await screen.findByText(PDF_COPY)).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'images.err.unsupported'))).not.toBeInTheDocument()
    expect(decodeMock).not.toHaveBeenCalled()
    expect(window.api.importDocuments).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Go to Documents' }))
    expect(onNavigate).toHaveBeenCalledWith('documents')
  })

  it('a picked PDF ("All files" in the picker) gets the same pointer, and its bytes are never read', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const picks = pickedImage('contract-scan.pdf')
    stubApi(visionScreenStubs(picks))
    render(<ImagesScreen onNavigate={onNavigate} />)
    await user.click(await screen.findByRole('button', { name: 'or choose an image' }))
    expect(await screen.findByText(PDF_COPY)).toBeInTheDocument()
    expect(picks.imageReadBytes).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Go to Documents' }))
    expect(onNavigate).toHaveBeenCalledWith('documents')
  })

  it('dismissing the PDF banner takes its button with it; another unsupported file keeps the generic copy', async () => {
    const user = userEvent.setup()
    stubApi(visionScreenStubs())
    render(<ImagesScreen onNavigate={vi.fn()} />)
    const zone = await findImageZone()
    await act(async () => {
      dropFiles(zone, [new File([new Uint8Array([1])], 'scan.pdf', { type: 'application/pdf' })])
    })
    await screen.findByText(PDF_COPY)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(PDF_COPY)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to Documents' })).not.toBeInTheDocument()

    await act(async () => {
      dropFiles(zone, [new File([new Uint8Array([1])], 'notes.docx', { type: '' })])
    })
    expect(await screen.findByText(t('en', 'images.err.unsupported'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to Documents' })).not.toBeInTheDocument()
  })

  // UX-3: the count is checked before any per-file check, so a PDF in the drop is still a multi-drop.
  it.each([
    ['two images', [['a.png', 'image/png'], ['b.png', 'image/png']]],
    ['a PDF among them', [['scan.pdf', 'application/pdf'], ['a.png', 'image/png']]]
  ] as const)('rejects a multi-drop (%s) with a friendly banner rather than taking the first file', async (_what, specs) => {
    stubApi(visionScreenStubs())
    render(<ImagesScreen onNavigate={vi.fn()} />)
    const zone = await findImageZone()
    await act(async () => {
      dropFiles(zone, specs.map(([name, type]) => new File([new Uint8Array([1])], name, { type })))
    })
    expect(await screen.findByText(t('en', 'images.err.multiDrop'))).toBeInTheDocument()
    expect(screen.queryByText(PDF_COPY)).not.toBeInTheDocument()
    // Still on the drop zone — no image was taken.
    expect(screen.getByText(t('en', 'images.drop.title'))).toBeInTheDocument()
    expect(decodeMock).not.toHaveBeenCalled()
  })
})

// #743: the three ways an image reaches decodeImage, each with its own catch that maps the failure to the
// banner — a drop (handleFile → decodeAndSelect), the picker (handleChoose, after imageReadBytes) and
// reopening a saved entry the stored-bytes fast path cannot take (no persisted dimensions, #121) — and the
// byte cap the drop and the picker check before any of that. decode.test.ts owns which code the pipeline
// throws; these rows own what the screen makes of it.
describe('ImagesScreen — decode failures and the byte cap (#743)', () => {
  type Arrival = 'dropped' | 'picked' | 'reopened'

  /** Mount the screen and return `offer(sizeBytes)`, which brings one image in by `how`: a dropped File or a
   *  picked file of `sizeBytes` (main's `stat` size), or the history entry `receipt.png` reopened. */
  async function mountFor(how: Arrival): Promise<(sizeBytes?: number) => Promise<void>> {
    const user = userEvent.setup()
    const picks = pickedImage('shot.png')
    stubApi(
      visionScreenStubs({
        ...picks,
        listImageSessions: vi.fn(async () => [imageSessionSummary()]),
        getImageSession: vi.fn(async () => imageSessionDetail({ width: null, height: null }))
      })
    )
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await screen.findByText('receipt.png') // the history read landed
    return async (sizeBytes = 4) => {
      if (how === 'dropped') {
        const file = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' })
        // The pre-check reads `size` alone, and the decode is mocked: four bytes stand in for a large file.
        Object.defineProperty(file, 'size', { value: sizeBytes })
        const zone = await findImageZone()
        await act(async () => {
          dropFiles(zone, [file])
        })
      } else if (how === 'picked') {
        picks.imageChooseImage.mockResolvedValueOnce({ token: `tok-${sizeBytes}`, name: 'shot.png', sizeBytes })
        await user.click(screen.getByRole('button', { name: 'or choose an image' }))
      } else {
        await user.click(screen.getByText('receipt.png'))
      }
    }
  }

  const ARRIVALS = ['dropped', 'picked', 'reopened'] as const
  // What decodeImage throws: its typed refusal (the #118 prescreen, the re-encoded byte cap) carries its own
  // code; anything else (a createImageBitmap or blob read failure) is "couldn't be opened".
  const FAILURES = [
    ["ImageDecodeError('tooLarge')", () => new ImageDecodeError('tooLarge'), 'images.err.tooLarge'],
    ['a plain Error', () => new Error('createImageBitmap failed'), 'images.err.decodeFailed']
  ] as const

  it.each(ARRIVALS.flatMap((how) => FAILURES.map(([what, error, key]) => [how, what, error, key] as const)))(
    'a %s image whose decode throws %s shows that copy and stays on the landing view',
    async (how, _what, error, key) => {
      const offer = await mountFor(how)
      decodeMock.mockRejectedValueOnce(error())
      await offer()
      expect(await screen.findByText(t('en', key))).toBeInTheDocument()
      expect(decodeMock).toHaveBeenCalledTimes(1) // the banner came from the decode, not an earlier guard
      expect(screen.queryByAltText('Selected image')).not.toBeInTheDocument()
      expect(screen.getByText(t('en', 'images.drop.title'))).toBeInTheDocument()
    }
  )

  it.each(['dropped', 'picked'] as const)(
    'a %s image one byte over the cap is refused as too large before any decode; one exactly at the cap is decoded',
    async (how) => {
      const offer = await mountFor(how)
      await offer(MAX_IMAGE_BYTES + 1)
      expect(await screen.findByText(t('en', 'images.err.tooLarge'))).toBeInTheDocument()
      expect(decodeMock).not.toHaveBeenCalled() // refused at the pre-check: nothing reached the decode
      expect(screen.getByText(t('en', 'images.drop.title'))).toBeInTheDocument()

      await offer(MAX_IMAGE_BYTES)
      expect(await screen.findByAltText('Selected image')).toBeInTheDocument()
      expect(decodeMock).toHaveBeenCalledTimes(1)
      expect(screen.queryByText(t('en', 'images.err.tooLarge'))).not.toBeInTheDocument()
    }
  )
})

describe('ImagesScreen — chips + analyze streaming (§5.4/§5.5)', () => {
  it('a chip fills the composer (no auto-send)', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)

    await user.click(screen.getByRole('button', { name: 'Extract visible text' }))
    const box = screen.getByPlaceholderText('Ask about this image…') as HTMLTextAreaElement
    expect(box.value).toBe(
      'Extract the visible text you can read. Preserve line breaks where helpful. Say if any text is unclear.'
    )
    // No auto-send: the store's analyze() reaches the bridge synchronously, so a send would show here.
    expect(s.analyze).not.toHaveBeenCalled()
    expect(screen.queryByText(t('en', 'images.answer.starting'))).not.toBeInTheDocument()
  })

  it('streams an answer: starting → tokens → done with Copy / Try again', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)

    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))

    // The calm starting line + a Stop, until the first token arrives.
    expect(await screen.findByText('Starting the vision model…')).toBeInTheDocument()
    await waitFor(() => expect(s.wired('j1')).toBe(true))

    await act(async () => s.token('j1', 'It is '))
    await act(async () => s.token('j1', 'a receipt.'))
    // PF-7c: tokens land on the store's 40 ms batch flush, not synchronously — findByText waits.
    expect(await screen.findByText(/It is a receipt\./)).toBeInTheDocument()

    await act(async () => s.done('j1', 'It is a receipt.'))
    expect(screen.getByText('Generated locally from the selected image.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('Copy uses the main-process clipboard (not navigator.clipboard, which the renderer denies)', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.done('j1', 'It is a receipt.'))

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(s.copyToClipboard).toHaveBeenCalledWith('It is a receipt.')
  })

  // The screen wiring of the error event; the per-code copy is AnswerThread.test.tsx's table.
  it('shows a friendly runtime-failure banner (never raw output)', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)

    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.error('j1', 'runtimeFailed'))
    expect(
      screen.getByText("The vision model couldn't start. Try again, or pick another model.")
    ).toBeInTheDocument()
  })

  // F4 (full audit 2026-06-30): vision is one-at-a-time. A prior turn's "Try again" used to stay
  // clickable while a different turn streamed, and analyze() then early-returned silently on the
  // busy job — the click vanished with no answer and no feedback. The trigger must now disable.
  it('disables a prior turn’s "Try again" while another analysis is in flight (F4)', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)

    // First analysis → done: its turn shows an ENABLED "Try again".
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.done('j1', 'A receipt.'))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()

    // Start a SECOND analysis (the composer is free again). The prior turn's "Try again" must go
    // disabled — the click can no longer be silently swallowed by the busy backend.
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'And this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled())
  })

  // PF-7c (full-audit 2026-07-10): stable handler identities (useEventCallback) + the token batch
  // flush mean a SETTLED turn's memoized row no longer re-renders on every stream flush of a
  // sibling turn — a per-id render-count oracle on TurnRow (the DocRow PERF-5 pattern).
  it('a settled TurnRow does not re-render while a new turn streams (PF-7c)', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)

    // First turn settles.
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.done('j1', 'A receipt.'))
    await screen.findByText('A receipt.')

    // Second turn starts streaming. Measure AFTER its first flush landed — the busy flip that
    // legitimately re-renders every row (it disables the settled row's "Try again") is behind us.
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'And this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.token('j1', 'One'))
    await screen.findByText(/One/)
    const before = new Map(turnRenders)
    // The store numbers its turns for the whole process (the production purge keeps the counter), so read the ids.
    const [settledId, streamingId] = getVisionSession().turns.map((tn) => tn.id)

    await act(async () => s.token('j1', ' two'))
    await screen.findByText(/One two/)
    const delta = (id: string): number =>
      (turnRenders.get(id) ?? 0) - (before.get(id) ?? 0)
    expect(delta(settledId)).toBe(0) // the settled row's memo held through the flush
    expect(delta(streamingId)).toBeGreaterThan(0) // the streaming row is the only one updating
  })
})

describe('ImagesScreen — reset + cancel (§5.6)', () => {
  it('Remove clears the image and the thread (back to the drop zone)', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'q')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.done('j1', 'Answer.'))
    expect(screen.getByText('Answer.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    // The thread + preview are gone; the drop zone is back.
    expect(screen.queryByText('Answer.')).not.toBeInTheDocument()
    expect(screen.getByText('Drop an image here')).toBeInTheDocument()
  })

  it('Stop cancels the active job and marks the turn stopped', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'q')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.token('j1', 'Half'))

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(s.cancel).toHaveBeenCalledWith('j1')
    expect(await screen.findByText('Stopped.')).toBeInTheDocument()
  })
})

describe('ImagesScreen — survives navigation (running analysis recovery)', () => {
  it('lands on the list with a running row after unmount + remount; clicking it shows the live stream', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    const { unmount } = render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.token('j1', 'Partial so far'))

    // Navigate away: the screen unmounts WITHOUT cancelling the in-flight job.
    unmount()
    expect(s.cancel).not.toHaveBeenCalled()

    // Come back: we land on the landing view (NOT the result view), and the running analysis is
    // surfaced as a row in the previous-results list.
    render(<ImagesScreen onNavigate={vi.fn()} />)
    expect(await screen.findByText('Analysis running…')).toBeInTheDocument()
    expect(screen.getByText('receipt.png')).toBeInTheDocument()
    // The upload is disabled while one runs (vision is one-at-a-time).
    expect(screen.getByRole('button', { name: 'or choose an image' })).toBeDisabled()

    // Clicking the running row opens the live detail view — the partial answer is intact.
    await user.click(screen.getByText('Analysis running…'))
    expect(await screen.findByText(/Partial so far/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    // The analysis completes, and the answer finalizes.
    await act(async () => s.done('j1', 'Partial so far — done.'))
    expect(await screen.findByText('Partial so far — done.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('Back returns to the list (analysis keeps running) without cancelling', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.token('j1', 'Half'))

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
  it('lists saved analyses on the landing view (file name + question count)', async () => {
    stubApi(visionScreenStubs({ listImageSessions: vi.fn(async () => [imageSessionSummary()]) }))
    render(<ImagesScreen onNavigate={vi.fn()} />)
    expect(await screen.findByText('History')).toBeInTheDocument()
    expect(await screen.findByText('receipt.png')).toBeInTheDocument()
    expect(screen.getByText('2 questions')).toBeInTheDocument()
  })

  it('deleting a saved analysis confirms, calls deleteImageSession, refreshes the list, and toasts', async () => {
    const deleteImageSession = vi.fn(async () => {})
    let calls = 0
    const listImageSessions = vi.fn(async () => (calls++ === 0 ? [imageSessionSummary()] : []))
    const user = userEvent.setup()
    stubApi(visionScreenStubs({ listImageSessions, deleteImageSession }))
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} />
      </ToastProvider>
    )

    await screen.findByText('receipt.png')
    // The row's Delete opens a ConfirmDialog; confirm inside the dialog (avoids the row button).
    await user.click(screen.getByRole('button', { name: 'Delete receipt.png' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteImageSession).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(screen.queryByText('receipt.png')).not.toBeInTheDocument())
    // The positive for the CODE-34 row below: a delete that worked says so.
    expect(await screen.findByText(t('en', 'images.history.deleted'))).toBeInTheDocument()
  })

  // full-audit 2026-07-11 CODE-34: a FAILED delete used to fall through to the success toast
  // ("Removed from history") while the entry stayed in the list.
  it('a failed delete shows the failure banner and never the success toast (CODE-34)', async () => {
    const deleteImageSession = vi.fn(async () => {
      throw new Error('The workspace is locked. Unlock it to continue.')
    })
    const listImageSessions = vi.fn(async () => [imageSessionSummary()])
    const user = userEvent.setup()
    stubApi(visionScreenStubs({ listImageSessions, deleteImageSession }))
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} />
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
    expect(screen.queryByText(t('en', 'images.history.deleted'))).not.toBeInTheDocument()
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
    stubApi(visionScreenStubs({ listImageSessions: vi.fn(async () => [imageSessionSummary()]), getImageSession }))
    render(<ImagesScreen onNavigate={vi.fn()} />)

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
    // Persisted dims AT the downscale target ⇒ no scaling needed (the `<=` bound, pinned where it is used).
    const getImageSession = vi.fn(async () =>
      imageSessionDetail({ mimeType: 'image/jpeg', width: DOWNSCALE_TARGET, height: 1024 })
    )
    const user = userEvent.setup()
    stubApi(visionScreenStubs({ listImageSessions: vi.fn(async () => [imageSessionSummary()]), getImageSession }))
    render(<ImagesScreen onNavigate={vi.fn()} />)

    await user.click(await screen.findByText('receipt.png'))
    // The clicked row's id, not its title.
    expect(getImageSession).toHaveBeenCalledWith('s1')
    // TEETH: pre-fix the reopen ALWAYS re-decoded (decode called once per open).
    expect(await screen.findByText('A receipt.')).toBeInTheDocument()
    expect(screen.getByAltText('Selected image')).toBeInTheDocument()
    expect(decodeMock).not.toHaveBeenCalled()
  })

  it.each([
    ['no persisted dimensions, a legacy row', { width: null, height: null }],
    ['one pixel above the downscale target', { width: DOWNSCALE_TARGET + 1, height: 1024 }]
  ] as const)('#121: an entry the fast path cannot prove (%s) still takes the full pipeline', async (_what, dims) => {
    const getImageSession = vi.fn(async () => imageSessionDetail({ ...dims, turns: [] }))
    const user = userEvent.setup()
    stubApi(visionScreenStubs({ listImageSessions: vi.fn(async () => [imageSessionSummary()]), getImageSession }))
    render(<ImagesScreen onNavigate={vi.fn()} />)

    await user.click(await screen.findByText('receipt.png'))
    await waitFor(() => expect(decodeMock).toHaveBeenCalledTimes(1))
  })

  // #122: the list says what it costs — per-entry stored size + the total in the header.
  it('#122: shows per-entry sizes and the total in the history header', async () => {
    stubApi(
      visionScreenStubs({
        listImageSessions: vi.fn(async () => [
          // Decimal megabytes (#768): in 1024 steps these read 1.9 MB and a 2.9 MB total.
          imageSessionSummary({ id: 's1', title: 'a.png', sizeBytes: 2_000_000 }),
          imageSessionSummary({ id: 's2', title: 'b.png', sizeBytes: 1_000_000 })
        ])
      })
    )
    render(<ImagesScreen onNavigate={vi.fn()} />)

    expect(await screen.findByText('Total: 3.0 MB')).toBeInTheDocument()
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('1.0 MB')).toBeInTheDocument()
  })

  it('#122: Clear history confirms, calls clearImageSessions, refreshes the list, and toasts', async () => {
    const clearImageSessions = vi.fn(async () => 1)
    let calls = 0
    const listImageSessions = vi.fn(async () => (calls++ === 0 ? [imageSessionSummary()] : []))
    const user = userEvent.setup()
    stubApi(visionScreenStubs({ listImageSessions, clearImageSessions }))
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} />
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
    const listImageSessions = vi.fn(async () => [imageSessionSummary()])
    const user = userEvent.setup()
    stubApi(visionScreenStubs({ listImageSessions, clearImageSessions }))
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} />
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

// #743: deleting the saved analysis that is open, or clearing the whole history, resets the vision store
// (deleteSession / clearHistory): a follow-up still running on that session is cancelled instead of
// completing into a session main has just shredded. Delete and Clear live on the list view only, so what
// shows is the running row going away and the store emptying. A run with no saved session yet is left alone.
describe('ImagesScreen — deleting or clearing the open saved analysis (#743)', () => {
  type User = ReturnType<typeof userEvent.setup>

  /** The history holds `receipt.png` (s1) and `extra`; delete and clear change what the next list read returns. */
  function historyStubs(s: VisionStream, extra: ImageSessionSummary[] = []): Partial<PreloadApi> {
    let saved = [imageSessionSummary(), ...extra]
    return {
      ...s.api,
      listImageSessions: vi.fn(async () => saved),
      getImageSession: vi.fn(async () => imageSessionDetail()),
      deleteImageSession: vi.fn(async (id: string) => {
        saved = saved.filter((x) => x.id !== id)
      }),
      clearImageSessions: vi.fn(async () => {
        const n = saved.length
        saved = []
        return n
      })
    }
  }

  function renderWithToasts(): void {
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} />
      </ToastProvider>
    )
  }

  /** Ask in the open detail view, wait until the job is wired, then go Back to the list (the run keeps going). */
  async function askThenBack(user: User, s: VisionStream): Promise<void> {
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'And the total?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await user.click(screen.getByRole('button', { name: '‹ Back to analyses' }))
    await screen.findByText(t('en', 'images.history.running'))
  }

  /** s1 reopened from the history, a follow-up running on it as j1, then Back to the list. */
  async function followUpRunningOnS1(extra: ImageSessionSummary[] = []): Promise<{ s: VisionStream; user: User }> {
    const user = userEvent.setup()
    // registerImagesIpc answers a follow-up with the session it appends to.
    const s = visionStream({ analyze: async () => ({ jobId: 'j1', state: 'queued', sessionId: 's1' }) })
    stubApi(historyStubs(s, extra))
    renderWithToasts()
    await user.click(await screen.findByText('receipt.png'))
    await screen.findByText('A receipt.')
    await askThenBack(user, s)
    expect(getVisionSession()).toMatchObject({ sessionId: 's1', activeJobId: 'j1' })
    return { s, user }
  }

  async function deleteEntry(user: User, title: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: `Delete ${title}` }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
  }

  async function clearAll(user: User): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Clear history' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear history' }))
  }

  it.each([
    ['deleting it', (user: User) => deleteEntry(user, 'receipt.png'), 'images.history.deleted'],
    ['clearing the history', clearAll, 'images.history.cleared']
  ] as const)('%s cancels the follow-up running on it and empties the store', async (_what, action, toastKey) => {
    const { s, user } = await followUpRunningOnS1()
    await action(user)
    // The toast comes after the reset: settle on it, then read what the reset did.
    expect(await screen.findByText(t('en', toastKey))).toBeInTheDocument()
    expect(s.cancel).toHaveBeenCalledWith('j1')
    expect(screen.queryByText(t('en', 'images.history.running'))).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'or choose an image' })).toBeEnabled()
    expect(getVisionSession()).toMatchObject({ selected: null, sessionId: null, activeJobId: null, analyzing: false })
  })

  it('deleting a different saved analysis leaves the open one running', async () => {
    const { s, user } = await followUpRunningOnS1([imageSessionSummary({ id: 's2', title: 'b.png' })])
    await deleteEntry(user, 'b.png')
    expect(await screen.findByText(t('en', 'images.history.deleted'))).toBeInTheDocument()
    expect(s.cancel).not.toHaveBeenCalled()
    expect(screen.getByText(t('en', 'images.history.running'))).toBeInTheDocument()
    expect(getVisionSession()).toMatchObject({ sessionId: 's1', activeJobId: 'j1', analyzing: true })
  })

  it('clearing the history leaves a fresh analysis with no saved session yet running', async () => {
    const user = userEvent.setup()
    // A fresh image: main answers with no session (it creates one on the first completed answer).
    const s = visionStream()
    stubApi({ ...historyStubs(s), ...pickedImage('shot.png') })
    renderWithToasts()
    await user.click(await screen.findByRole('button', { name: 'or choose an image' }))
    await screen.findByAltText('Selected image')
    await askThenBack(user, s)

    await clearAll(user)
    expect(await screen.findByText(t('en', 'images.history.cleared'))).toBeInTheDocument()
    expect(s.cancel).not.toHaveBeenCalled()
    expect(screen.getByText(t('en', 'images.history.running'))).toBeInTheDocument()
    expect(getVisionSession()).toMatchObject({ sessionId: null, activeJobId: 'j1', analyzing: true })
  })
})

describe('ImagesScreen — copy feedback (full-audit 2026-07-11 CODE-36)', () => {
  it('a failed copy toasts the failure instead of staying silent', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    s.copyToClipboard.mockResolvedValue(false) // main refused the write
    stubApi({ ...s.api, ...pickedImage() })
    render(
      <ToastProvider>
        <ImagesScreen onNavigate={vi.fn()} />
      </ToastProvider>
    )
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'q')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.done('j1', 'Answer.'))

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    // TEETH: pre-fix a refused copy gave NO feedback at all (the `if (ok)` gate).
    expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'images.answer.copied'))).not.toBeInTheDocument()
  })
})

// DOC-12 + DOC-13 (frontend audit 2026-08-09, #150 — #143 companions).
describe('ImagesScreen — analysis-window guards (DOC-12/DOC-13)', () => {
  it('DOC-12: Replace and Remove are disabled while an analysis streams; after it settles, Replace resets the thread without a cancel', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
    await selectImageViaPicker(user)
    await user.type(screen.getByPlaceholderText('Ask about this image…'), 'What is this?')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByText('Starting the vision model…')

    // Pre-fix Replace gated only on `decoding`: a stray click mid-analysis opened the picker
    // and cancelled the streaming answer without confirmation.
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()

    await waitFor(() => expect(s.wired('j1')).toBe(true))
    await act(async () => s.done('j1', 'A receipt.'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace' })).toBeEnabled())

    // Settled: Replace picks a new image and the previous turn is gone (the thread reset for it);
    // nothing runs, so nothing is cancelled. The store's supersede/cancel invariant stays covered
    // in visionSession.test.ts.
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(screen.queryByText('A receipt.')).not.toBeInTheDocument())
    expect(s.cancel).not.toHaveBeenCalled()
  })

  it('DOC-13: a busy-refused Ask restores the typed question instead of discarding it', async () => {
    const user = userEvent.setup()
    const s = visionStream()
    stubApi({ ...s.api, ...pickedImage() })
    render(<ImagesScreen onNavigate={vi.fn()} />)
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
