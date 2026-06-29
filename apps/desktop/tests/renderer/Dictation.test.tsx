// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Composer } from '../../src/renderer/chat/Composer'
import { DictationButton } from '../../src/renderer/chat/DictationButton'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { t } from '../../src/shared/i18n'
import type { DictationCapture, DictationCaptureStart } from '../../src/renderer/lib/dictation'
import { MIC_BLOCKED_MESSAGE } from '../../src/renderer/lib/dictation'
import type { AppStatus, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Voice dictation in the composer (Phase 37, D30): availability gating (the mic exists
// only when a transcriber is selected), the record → transcribe → insert-at-cursor flow
// (with the capture pipeline faked behind the DictationButton seam and the preload
// stubbed), friendly failure copy, and the hard rule that dictation NEVER sends.

function appStatus(over: Partial<AppStatus> = {}): AppStatus {
  return {
    appName: 'x',
    appVersion: '0',
    offlineMode: true,
    networkAllowed: false,
    activeModelId: 'm1',
    hardwareProfile: 'UNKNOWN',
    workspaceMode: 'plaintext_dev',
    workspaceReady: true,
    machineRamGb: 16,
    dictationAvailable: false,
    ocrAvailable: false,
    ...over
  }
}

function runtimeStatus(): RuntimeStatus {
  return { running: true, modelId: 'm1', port: 1234, healthy: true, message: 'ok' }
}

/** A capture whose stop() resolves with fixed bytes — the renderer-side fake mic. */
function fakeCapture(bytes = new Uint8Array([1, 2, 3])): {
  start: DictationCaptureStart
  cancel: ReturnType<typeof vi.fn>
} {
  const cancel = vi.fn()
  // analyser: null — jsdom has no Web Audio. The Composer's waveform overlay must
  // no-op (render nothing) on a null analyser; the record flow stays unaffected.
  const capture: DictationCapture = { stop: async () => bytes, cancel, analyser: null }
  return { start: async () => capture, cancel }
}

/** Stateful Composer harness (the real Composer is controlled by ChatScreen). */
function Harness(props: {
  initial?: string
  capture?: DictationCaptureStart
  onError?: (m: string) => void
  onSend?: () => void
  available?: boolean
}): JSX.Element {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={props.onSend ?? (() => {})}
      onStop={() => {}}
      streaming={false}
      placeholder="Message…"
      sendLabel="Send"
      dictationAvailable={props.available ?? true}
      onDictationError={props.onError}
      dictationCaptureImpl={props.capture}
    />
  )
}

function micButton(): HTMLElement {
  return screen.getByRole('button', { name: /dictate a message/i })
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('availability gating (D14 precedent)', () => {
  it('ChatScreen shows the mic only when the app reports a transcriber', async () => {
    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ dictationAvailable: true })),
      getRuntimeStatus: vi.fn(async () => runtimeStatus()),
      listConversations: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [])
    })
    const { unmount } = render(<ChatScreen onNavigate={() => {}} />)
    expect(await screen.findByRole('button', { name: /dictate a message/i })).toBeInTheDocument()
    unmount()

    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ dictationAvailable: false })),
      getRuntimeStatus: vi.fn(async () => runtimeStatus()),
      listConversations: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [])
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await screen.findByPlaceholderText('Message…')
    expect(screen.queryByRole('button', { name: /dictate a message/i })).not.toBeInTheDocument()
  })

  it('the Composer hides the mic when dictation is unavailable (default)', () => {
    render(
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        streaming={false}
        placeholder="Message…"
        sendLabel="Send"
      />
    )
    expect(screen.queryByRole('button', { name: /dictate/i })).not.toBeInTheDocument()
  })
})

describe('record → transcribe → insert at the cursor', () => {
  it('inserts the transcribed text at the caret with sane spacing — and never sends', async () => {
    const user = userEvent.setup()
    const transcribe = vi.fn(async (_bytes: Uint8Array) => ' hello world ')
    stubApi({ transcribeDictation: transcribe })
    const onSend = vi.fn()
    const { start } = fakeCapture(new Uint8Array([7, 7]))
    render(<Harness initial="foo bar" capture={start} onSend={onSend} />)

    // Caret after "foo" — dictation must land mid-text, not append.
    const input = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
    input.setSelectionRange(3, 3)

    await user.click(micButton()) // start recording
    const stopBtn = await screen.findByRole('button', { name: /stop dictation/i })
    expect(stopBtn).toHaveAttribute('aria-pressed', 'true')
    await user.click(stopBtn) // stop → transcribe → insert

    await waitFor(() => expect(input.value).toBe('foo hello world bar'))
    // The recorded bytes went over the dictation IPC, not anywhere else.
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(transcribe.mock.calls[0][0]).toEqual(new Uint8Array([7, 7]))
    // Never auto-sent: review stays with the user.
    expect(onSend).not.toHaveBeenCalled()
    // The caret sits after the inserted text (fallback insert path restores it).
    await waitFor(() => expect(input.selectionStart).toBe('foo hello world'.length))
  })

  it('engages the recording affordance (dim + waveform overlay) only while recording', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => 'x') })
    const { start } = fakeCapture()
    const { container } = render(<Harness capture={start} />)
    const row = container.querySelector('.composer-row') as HTMLElement

    expect(row).not.toHaveClass('composer-recording')
    await user.click(micButton())
    await screen.findByRole('button', { name: /stop dictation/i })
    // recording → row carries the dim/overlay class (works even with a null analyser:
    // Web Audio is absent in jsdom, so the canvas no-ops but the affordance still shows).
    expect(row).toHaveClass('composer-recording')

    await user.click(screen.getByRole('button', { name: /stop dictation/i }))
    await waitFor(() => expect(row).not.toHaveClass('composer-recording'))
  })

  it('appends without doubling whitespace when the input is empty', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => 'dictated text') })
    const { start } = fakeCapture()
    render(<Harness capture={start} />)

    await user.click(micButton())
    await user.click(await screen.findByRole('button', { name: /stop dictation/i }))

    const input = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe('dictated text'))
  })

  it('reports the no-speech notice instead of inserting when nothing was recognized', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => '   ') })
    const onError = vi.fn()
    const { start } = fakeCapture()
    render(<Harness initial="keep me" capture={start} onError={onError} />)

    await user.click(micButton())
    await user.click(await screen.findByRole('button', { name: /stop dictation/i }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith(t('en', 'chat.dictation.noSpeech')))
    expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('keep me')
  })
})

describe('friendly failures (§11.4)', () => {
  it('surfaces the main-process refusal with the IPC transport prefix stripped', async () => {
    const user = userEvent.setup()
    stubApi({
      transcribeDictation: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'dictation:transcribe': Error: Could not transcribe that — try again."
        )
      })
    })
    const onError = vi.fn()
    const { start } = fakeCapture()
    render(<Harness capture={start} onError={onError} />)

    await user.click(micButton())
    await user.click(await screen.findByRole('button', { name: /stop dictation/i }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Could not transcribe that — try again.'))
    // The button is usable again after a failure.
    expect(micButton()).toBeEnabled()
  })

  it('surfaces the mic-blocked copy when the capture cannot start, and recovers', async () => {
    const user = userEvent.setup()
    stubApi({})
    const onError = vi.fn()
    const start: DictationCaptureStart = async () => {
      throw new Error(MIC_BLOCKED_MESSAGE)
    }
    render(<Harness capture={start} onError={onError} />)

    await user.click(micButton())
    await waitFor(() => expect(onError).toHaveBeenCalledWith(MIC_BLOCKED_MESSAGE))
    expect(micButton()).toBeEnabled()
    expect(micButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('releases the microphone when the composer unmounts mid-recording', async () => {
    const user = userEvent.setup()
    stubApi({})
    const { start, cancel } = fakeCapture()
    const { unmount } = render(<Harness capture={start} />)

    await user.click(micButton())
    await screen.findByRole('button', { name: /stop dictation/i })
    unmount()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  // F21 (audit postmerge): the harder leak — the component unmounts WHILE getUserMedia is
  // still pending (the OS mic prompt is open). The unmount cleanup runs first and sees no
  // capture to release; then the promise resolves, handing back a LIVE MediaStream. Without
  // the mountedRef guard, start() would store it on the dead component and never stop() it —
  // the OS recording indicator stays lit until GC. The guard must cancel it immediately and
  // never touch the unmounted component (no onRecording).
  it('cancels a capture that resolves AFTER unmount and never enters recording (F21)', async () => {
    const user = userEvent.setup()
    stubApi({})
    const cancel = vi.fn()
    const capture: DictationCapture = { stop: async () => new Uint8Array(), cancel, analyser: null }
    let resolveCapture!: (c: DictationCapture) => void
    const captureImpl: DictationCaptureStart = () =>
      new Promise<DictationCapture>((res) => {
        resolveCapture = res
      })
    const onRecording = vi.fn()
    const { unmount } = render(
      <DictationButton onText={() => {}} onRecording={onRecording} captureImpl={captureImpl} />
    )

    // Click to record → start() awaits the (parked) getUserMedia. Then navigate away.
    await user.click(micButton())
    expect(resolveCapture).toBeDefined()
    unmount()

    // The OS prompt now resolves — on the unmounted component.
    await act(async () => {
      resolveCapture(capture)
    })

    expect(cancel).toHaveBeenCalledTimes(1) // the just-acquired live stream is released
    // Never ENTERED recording on the dead component — onRecording(_, true) must not fire.
    // (The unmount cleanup's onRecording(null, false) wave-clear is expected and fine.)
    expect(onRecording.mock.calls.some(([, recording]) => recording === true)).toBe(false)
  })
})
