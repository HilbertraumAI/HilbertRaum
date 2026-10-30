// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Composer } from '../../src/renderer/chat/Composer'
import { DictationButton } from '../../src/renderer/chat/DictationButton'
import { DEFAULT_NO_SIGNAL_TIMING } from '../../src/renderer/chat/useNoSignalHint'
import { t } from '../../src/shared/i18n'
import type { DictationCapture, DictationCaptureStart } from '../../src/renderer/lib/dictation'
import {
  DICTATION_SILENT_MESSAGE,
  DICTATION_TOO_SHORT_MESSAGE,
  MIC_BLOCKED_MESSAGE
} from '../../src/renderer/lib/dictation'
import type { TranscriberMissing } from '../../src/shared/types'
import type { MessageKey } from '../../src/shared/i18n'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { appStatus } from '../helpers/status'
import { chatScreenStubs, renderChatScreen } from '../helpers/chat-screen'
import { renderInLanguage } from '../helpers/render-language'

// Voice dictation in the composer (Phase 37, D30): availability gating (the mic exists
// only when a transcriber is selected), the record → transcribe → insert-at-cursor flow
// (with the capture module's `captureDictation` mocked below and the preload stubbed),
// friendly failure copy, and the hard rule that dictation NEVER sends.

// The capture pipeline (getUserMedia → MediaRecorder → Web Audio) needs a browser: `captureDictation` is
// replaced, and each row puts the capture its mic click should get in `captureSlot.next`. The message
// constants stay real.
const captureSlot = vi.hoisted(() => ({ next: null as DictationCaptureStart | null }))
vi.mock('../../src/renderer/lib/dictation', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/renderer/lib/dictation')>()
  return {
    ...m,
    captureDictation: vi.fn(() =>
      captureSlot.next ? captureSlot.next() : Promise.reject(new Error('no fake capture set for this row'))
    )
  }
})

/** A capture whose stop() resolves with fixed bytes — the renderer-side fake mic. */
function fakeCapture(
  bytes = new Uint8Array([1, 2, 3]),
  analyser: AnalyserNode | null = null
): {
  start: DictationCaptureStart
  cancel: ReturnType<typeof vi.fn>
} {
  const cancel = vi.fn()
  // analyser: null by default — jsdom has no Web Audio. The Composer's waveform overlay must
  // no-op (render nothing) on a null analyser; the record flow stays unaffected. The no-signal
  // and waveform tests pass a fake tap instead.
  const capture: DictationCapture = { stop: async () => bytes, cancel, analyser }
  return { start: async () => capture, cancel }
}

/** A stand-in for the Web Audio tap: every time-domain frame is filled with `level.value`. */
function fakeAnalyser(level: { value: number }): AnalyserNode {
  return {
    fftSize: 8,
    getFloatTimeDomainData: (arr: Float32Array) => arr.fill(level.value)
  } as unknown as AnalyserNode
}

/** Stateful Composer harness (the real Composer is controlled by ChatScreen). */
function Harness(props: {
  initial?: string
  onError?: (m: string) => void
  onSend?: () => void
  available?: boolean
  missing?: TranscriberMissing | null
  onOpenModels?: () => void
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
      dictationMissing={props.missing}
      onDictationError={props.onError}
      onOpenModels={props.onOpenModels}
    />
  )
}

function micButton(): HTMLElement {
  return screen.getByRole('button', { name: /dictate a message/i })
}

afterEach(() => {
  assertNoUnexpectedApiCalls()
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  captureSlot.next = null
})

describe('availability gating (D14 precedent)', () => {
  it('ChatScreen shows the mic only when the app reports a transcriber', async () => {
    stubApi(
      chatScreenStubs({
        getAppStatus: vi.fn(async () => appStatus({ activeModelId: 'm1', dictationAvailable: true }))
      })
    )
    const { unmount } = renderChatScreen()
    expect(await screen.findByRole('button', { name: /dictate a message/i })).toBeInTheDocument()
    unmount()
    assertNoUnexpectedApiCalls() // the next stubApi starts a fresh record

    stubApi(
      chatScreenStubs({
        getAppStatus: vi.fn(async () => appStatus({ activeModelId: 'm1', dictationAvailable: false }))
      })
    )
    renderChatScreen()
    await screen.findByPlaceholderText('Message…')
    // #497: unavailable is no longer invisible — the "not installed" mic stands in for it.
    expect(await screen.findByRole('button', { name: t('en', 'chat.dictation.unavailable') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dictate a message/i })).not.toBeInTheDocument()
  })

  it('ChatScreen re-reads availability on window focus — a download that finished while the user stayed in chat (#497)', async () => {
    const getAppStatus = vi.fn(async () => appStatus({ activeModelId: 'm1', dictationAvailable: false }))
    stubApi(chatScreenStubs({ getAppStatus }))
    renderChatScreen()
    await screen.findByPlaceholderText('Message…')
    // Wait for the status read (the "not installed" mic), so the negative is not just an unread status.
    expect(await screen.findByRole('button', { name: t('en', 'chat.dictation.unavailable') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dictate a message/i })).not.toBeInTheDocument()

    // Main re-selected the transcriber when the speech model landed (the #497 hook); the open
    // chat screen learns of it on the next focus, exactly like the Translate screen does.
    getAppStatus.mockImplementation(async () => appStatus({ activeModelId: 'm1', dictationAvailable: true }))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await screen.findByRole('button', { name: /dictate a message/i })).toBeInTheDocument()
  })

  it('renders no mic at all while the status is unread — no flash on mount (#497)', () => {
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
    // Neither the live mic nor either "not installed" mic: Send is the only button.
    expect(screen.queryByRole('button', { name: /dictate a message/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('en', 'chat.dictation.unavailable') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('en', 'chat.dictation.unavailableSystem') })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Send'])
  })
})

// #497 (discoverability): on a drive without the speech model the mic used to vanish, and the
// only pointer to dictation was a sentence in the user guide. The composer now shows a visibly
// disabled mic whose click explains what is missing and deep-links to the AI Model screen.
// `undefined` (status not read yet) still renders nothing — no flash on mount.
describe('the "not installed" mic (#497 — discoverable, never hidden)', () => {
  it('renders a visibly disabled mic when dictation is unavailable — never the live one, no hint until asked', () => {
    render(<Harness available={false} />)
    const mic = screen.getByRole('button', { name: t('en', 'chat.dictation.unavailable') })
    expect(mic).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('button', { name: /dictate a message/i })).not.toBeInTheDocument()
    expect(screen.queryByText(t('en', 'chat.dictation.needsModel'))).not.toBeInTheDocument()
  })

  it('one click explains what is missing; one more opens the AI Model screen', async () => {
    const user = userEvent.setup()
    const onOpenModels = vi.fn()
    // No 'missing' prop: an older main without AppStatus.transcriberMissing falls back to the speech-model copy (#527).
    render(<Harness available={false} onOpenModels={onOpenModels} />)
    await user.click(screen.getByRole('button', { name: t('en', 'chat.dictation.unavailable') }))
    expect(screen.getByText(t('en', 'chat.dictation.needsModel'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: t('en', 'chat.dictation.getModel') }))
    expect(onOpenModels).toHaveBeenCalledTimes(1)
    // A second click on the mic folds the hint away again.
    await user.click(screen.getByRole('button', { name: t('en', 'chat.dictation.unavailable') }))
    expect(screen.queryByText(t('en', 'chat.dictation.needsModel'))).not.toBeInTheDocument()
  })

  it('ChatScreen threads the deep link: the hint navigates to the AI Model screen', async () => {
    const user = userEvent.setup()
    stubApi(
      chatScreenStubs({
        getAppStatus: vi.fn(async () => appStatus({ activeModelId: 'm1', dictationAvailable: false }))
      })
    )
    const { onNavigate } = renderChatScreen()
    await user.click(await screen.findByRole('button', { name: t('en', 'chat.dictation.unavailable') }))
    const composer = document.querySelector('.composer') as HTMLElement
    await user.click(within(composer).getByRole('button', { name: t('en', 'chat.dictation.getModel') }))
    // #527: straight to the speech model on Browse, not the installed-models view.
    expect(onNavigate).toHaveBeenCalledWith('models:voice')
  })
})

// #527: the hint used to blame the speech model in every case and borrowed "Open AI Model" for
// its button. On a Linux drive (v1.8.6 engine: Windows-only) the model was installed and the
// ENGINE was missing — with no build the app could install. Each cause now has its own text and
// button, and the cause with nothing to fetch has no button at all.
describe('the "not installed" hint names the missing piece (#527)', () => {
  const CASES: { missing: TranscriberMissing; text: MessageKey; action: MessageKey }[] = [
    { missing: 'model', text: 'chat.dictation.needsModel', action: 'chat.dictation.getModel' },
    { missing: 'engine', text: 'chat.dictation.needsEngine', action: 'chat.dictation.getEngine' },
    { missing: 'model-and-engine', text: 'chat.dictation.needsModelAndEngine', action: 'chat.dictation.setUp' }
  ]

  for (const c of CASES) {
    // No button reads "Open AI …": next to "AI" the verb parses as the company name.
    it(`${c.missing}: names it and offers its own action, never "Open AI …"`, async () => {
      const user = userEvent.setup()
      const onOpenModels = vi.fn()
      render(<Harness available={false} missing={c.missing} onOpenModels={onOpenModels} />)
      await user.click(screen.getByRole('button', { name: t('en', 'chat.dictation.unavailable') }))
      expect(screen.getByText(t('en', c.text))).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /open ai/i })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: t('en', c.action) }))
      expect(onOpenModels).toHaveBeenCalledTimes(1)
    })
  }

  it('engine-unsupported: says it is not available on this operating system, with no dead-end button', async () => {
    const user = userEvent.setup()
    render(<Harness available={false} missing="engine-unsupported" onOpenModels={vi.fn()} />)
    // The mic's own name changes too: nothing is "not installed on this drive" that could be.
    expect(screen.queryByRole('button', { name: t('en', 'chat.dictation.unavailable') })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: t('en', 'chat.dictation.unavailableSystem') }))
    const hint = screen.getByText(t('en', 'chat.dictation.engineUnsupported'))
    expect(within(hint).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(t('en', 'chat.dictation.needsModel'))).not.toBeInTheDocument()
  })

  it('ChatScreen reads the cause from the app status and re-reads it on focus', async () => {
    const user = userEvent.setup()
    const getAppStatus = vi.fn(async () =>
      appStatus({ activeModelId: 'm1', dictationAvailable: false, transcriberMissing: 'model-and-engine' })
    )
    stubApi(chatScreenStubs({ getAppStatus }))
    renderChatScreen()
    await user.click(await screen.findByRole('button', { name: t('en', 'chat.dictation.unavailable') }))
    expect(screen.getByText(t('en', 'chat.dictation.needsModelAndEngine'))).toBeInTheDocument()

    // The voice engine landed while the user stayed in chat; only the model is missing now.
    getAppStatus.mockImplementation(async () =>
      appStatus({ activeModelId: 'm1', dictationAvailable: false, transcriberMissing: 'model' })
    )
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await screen.findByText(t('en', 'chat.dictation.needsModel'))).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'chat.dictation.needsModelAndEngine'))).not.toBeInTheDocument()
  })
})

// #497 follow-up (owner request): while recording, the composer says at once when nothing is
// reaching the microphone — sampled from the waveform's Web Audio tap against the same −50 dBFS
// floor the post-stop gate applies. The rows run the SHIPPED timing (2 s, sampled every 250 ms)
// on a fake clock that fakes only the hook's own: its interval and `Date.now()`. userEvent and
// RTL keep real time.
describe('the live "no signal" hint while recording', () => {
  const noSignalText = (): string => t('en', 'chat.dictation.noSignal')
  // The first tick that may show the hint: the first silent sample starts the clock (at one poll),
  // and the window runs from there.
  const EDGE = DEFAULT_NO_SIGNAL_TIMING.afterMs + DEFAULT_NO_SIGNAL_TIMING.pollMs
  const advance = async (ms: number): Promise<void> => {
    await act(() => vi.advanceTimersByTimeAsync(ms))
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Click the mic and wait until recording, with the hook's interval started at the current fake time. */
  async function startRecording(user: ReturnType<typeof userEvent.setup>, capture: DictationCaptureStart): Promise<void> {
    captureSlot.next = capture
    await user.click(micButton())
    await screen.findByRole('button', { name: /stop dictation/i })
    await act(async () => {}) // flush the recording effects: the hook arms its interval here
  }

  it('appears once the tap has stayed silent for the window, and clears the moment sound comes in', async () => {
    // The values architecture.md and known-limitations.md state ("for 2 s", "four times a second").
    expect(DEFAULT_NO_SIGNAL_TIMING).toEqual({ afterMs: 2000, pollMs: 250 })
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => 'text') })
    const level = { value: 0 } // digital silence — a muted or blocked device
    render(<Harness />)
    await startRecording(user, fakeCapture(new Uint8Array([1]), fakeAnalyser(level)).start)

    await advance(EDGE - 1)
    expect(screen.queryByText(noSignalText())).not.toBeInTheDocument()
    await advance(1)
    expect(screen.getByText(noSignalText())).toBeInTheDocument()

    level.value = 0.2 // −14 dBFS: the user started talking
    await advance(DEFAULT_NO_SIGNAL_TIMING.pollMs)
    expect(screen.queryByText(noSignalText())).not.toBeInTheDocument()
  })

  it('never appears while there is signal, and is gone once recording stops', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => 'text') })
    const level = { value: 0.2 }
    render(<Harness />)
    await startRecording(user, fakeCapture(new Uint8Array([1]), fakeAnalyser(level)).start)

    await advance(EDGE + DEFAULT_NO_SIGNAL_TIMING.pollMs)
    expect(screen.queryByText(noSignalText())).not.toBeInTheDocument()

    level.value = 0 // positive control: the same tap gone silent shows it
    await advance(EDGE)
    expect(screen.getByText(noSignalText())).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /stop dictation/i }))
    await act(async () => {})
    expect(screen.queryByText(noSignalText())).not.toBeInTheDocument()
  })

  it('stays silent without a Web Audio tap (analyser null) — the post-stop gate still covers that', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => 'text') })
    render(<Harness />)
    await startRecording(user, fakeCapture().start)

    await advance(EDGE * 2)
    expect(screen.queryByText(noSignalText())).not.toBeInTheDocument()
  })
})

describe('record → transcribe → insert at the cursor', () => {
  it('inserts the transcribed text at the caret with sane spacing — and never sends', async () => {
    const user = userEvent.setup()
    const transcribe = vi.fn(async (_bytes: Uint8Array) => ' hello world ')
    stubApi({ transcribeDictation: transcribe })
    const onSend = vi.fn()
    captureSlot.next = fakeCapture(new Uint8Array([7, 7])).start
    render(<Harness initial="foo bar" onSend={onSend} />)

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
    captureSlot.next = fakeCapture(new Uint8Array([1]), fakeAnalyser({ value: 0.2 })).start
    const { container } = render(<Harness />)
    const row = container.querySelector('.composer-row') as HTMLElement
    const waveform = (): Element | null => container.querySelector('canvas.dictation-waveform')

    expect(row).not.toHaveClass('composer-recording')
    expect(waveform()).toBeNull()
    await user.click(micButton())
    await screen.findByRole('button', { name: /stop dictation/i })
    // recording → the row carries the dim class, and the waveform canvas draws the live tap over the input.
    expect(row).toHaveClass('composer-recording')
    expect(waveform()).not.toBeNull()

    await user.click(screen.getByRole('button', { name: /stop dictation/i }))
    await waitFor(() => expect(row).not.toHaveClass('composer-recording'))
    await waitFor(() => expect(waveform()).toBeNull())
  })

  it('appends without doubling whitespace when the input is empty', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => 'dictated text') })
    captureSlot.next = fakeCapture().start
    render(<Harness />)

    await user.click(micButton())
    await user.click(await screen.findByRole('button', { name: /stop dictation/i }))

    const input = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe('dictated text'))
  })

  it('reports the no-speech notice instead of inserting when nothing was recognized', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => '   ') })
    const onError = vi.fn()
    captureSlot.next = fakeCapture().start
    render(<Harness initial="keep me" onError={onError} />)

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
    captureSlot.next = fakeCapture().start
    render(<Harness onError={onError} />)

    await user.click(micButton())
    await user.click(await screen.findByRole('button', { name: /stop dictation/i }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Could not transcribe that — try again.'))
    // The button is usable again after a failure.
    expect(micButton()).toBeEnabled()
  })

  // lib/dictation throws canonical English and DictationButton localizes it at display. The English
  // catalog value equals the constant byte for byte, so the rows below run in German: only there does
  // a dropped mapping show (the English constant would pass straight through).
  it('surfaces the mic-blocked copy when the capture cannot start, and recovers', async () => {
    const user = userEvent.setup()
    stubApi({})
    const onError = vi.fn()
    captureSlot.next = async () => {
      throw new Error(MIC_BLOCKED_MESSAGE)
    }
    renderInLanguage(<Harness onError={onError} />, 'de')
    const mic = (): HTMLElement => screen.getByRole('button', { name: t('de', 'chat.dictation.start') })

    await user.click(mic())
    await waitFor(() => expect(onError).toHaveBeenCalledWith(t('de', 'chat.dictation.micBlocked')))
    expect(mic()).toBeEnabled()
    expect(mic()).toHaveAttribute('aria-pressed', 'false')
  })

  // #497: the renderer gate refuses a recording with no usable signal BEFORE the IPC — nothing
  // is sent, whisper never runs, and the copy tells the user what to check. Localized at display
  // from the canonical English constant, the MIC_BLOCKED_MESSAGE pattern.
  it('surfaces the silent-recording copy when the capture carried no signal, sends nothing, and recovers (#497)', async () => {
    const user = userEvent.setup()
    const transcribe = vi.fn(async () => 'never')
    stubApi({ transcribeDictation: transcribe })
    const onError = vi.fn()
    const capture: DictationCapture = {
      stop: async () => {
        throw new Error(DICTATION_SILENT_MESSAGE)
      },
      cancel: vi.fn(),
      analyser: null
    }
    captureSlot.next = async () => capture
    renderInLanguage(<Harness initial="keep me" onError={onError} />, 'de')
    const mic = (): HTMLElement => screen.getByRole('button', { name: t('de', 'chat.dictation.start') })

    await user.click(mic())
    await user.click(await screen.findByRole('button', { name: t('de', 'chat.dictation.stop') }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith(t('de', 'chat.dictation.silent')))
    expect(transcribe).not.toHaveBeenCalled()
    expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('keep me')
    expect(mic()).toBeEnabled()
  })

  it('maps a too-short recording to the no-speech copy, not the microphone copy (#497)', async () => {
    const user = userEvent.setup()
    stubApi({ transcribeDictation: vi.fn(async () => 'never') })
    const onError = vi.fn()
    const capture: DictationCapture = {
      stop: async () => {
        throw new Error(DICTATION_TOO_SHORT_MESSAGE)
      },
      cancel: vi.fn(),
      analyser: null
    }
    captureSlot.next = async () => capture
    render(<Harness onError={onError} />)

    await user.click(micButton())
    await user.click(await screen.findByRole('button', { name: /stop dictation/i }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith(t('en', 'chat.dictation.noSpeech')))
  })

  it('releases the microphone when the composer unmounts mid-recording', async () => {
    const user = userEvent.setup()
    stubApi({})
    const { start, cancel } = fakeCapture()
    captureSlot.next = start
    const { unmount } = render(<Harness />)

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
    captureSlot.next = () =>
      new Promise<DictationCapture>((res) => {
        resolveCapture = res
      })
    const onRecording = vi.fn()
    const { unmount } = render(<DictationButton onText={() => {}} onRecording={onRecording} />)

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

  // F1 (full audit 2026-06-30): the stop side of the same leak. stopAndTranscribe() awaits the
  // multi-second transcribeDictation IPC, then fires onText(text). If the user stops dictation
  // and navigates away (or switches conversation) before the transcript returns, an unguarded
  // onText sets the now-foreign composer's input — the user's words land in a DIFFERENT
  // conversation. The mountedRef guard (mirroring start()'s F21) must let the IPC finish
  // harmlessly and never call onText/onError/setState on the dead component.
  it('does NOT fire onText when transcribeDictation resolves AFTER unmount (F1)', async () => {
    const user = userEvent.setup()
    // The transcribe IPC is parked until we release it explicitly — AFTER unmount.
    let resolveTranscribe!: (text: string) => void
    stubApi({
      transcribeDictation: vi.fn(
        () =>
          new Promise<string>((res) => {
            resolveTranscribe = res
          })
      )
    })
    captureSlot.next = fakeCapture().start
    const onText = vi.fn()
    const onError = vi.fn()
    const { unmount } = render(<DictationButton onText={onText} onError={onError} />)

    await user.click(micButton()) // start recording
    await user.click(await screen.findByRole('button', { name: /stop dictation/i })) // stop → transcribe (parked)
    expect(resolveTranscribe).toBeDefined()

    unmount() // navigate away while the transcript is still in flight

    // The IPC now resolves on the unmounted component — must be swallowed silently.
    await act(async () => {
      resolveTranscribe('leaked into another conversation')
    })

    expect(onText).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
