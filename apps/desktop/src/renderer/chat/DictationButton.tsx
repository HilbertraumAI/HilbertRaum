import { useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '../components'
import {
  captureDictation,
  MIC_BLOCKED_MESSAGE,
  type DictationCapture,
  type DictationCaptureStart
} from '../lib/dictation'
import { friendlyIpcError } from '../lib/errors'
import { useT } from '../i18n'

// Voice dictation: the composer mic. Click to record (the OS mic
// indicator is the recording signal), click again to stop — the audio is resampled
// in-page, transcribed locally by the drive's whisper model, and the text lands in
// the input FOR REVIEW. Nothing is ever auto-sent, and the recording never leaves
// the machine. The button renders only when a transcriber is available
// (availability-driven — ChatScreen gates on `dictationAvailable`; no settings key).

type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'

interface DictationButtonProps {
  /** Disabled while an answer is streaming (the composer's Send is Stop then). */
  disabled?: boolean
  /** Receives the transcribed text; the composer inserts it at the cursor. */
  onText: (text: string) => void
  /** Friendly failure copy — surfaced by the screen (Banner), like other chat errors. */
  onError?: (message: string) => void
  /** Fires on enter/exit of the recording state with the live mic tap (null when not
   *  recording, or when Web Audio is unavailable) — drives the in-input waveform + dim. */
  onRecording?: (analyser: AnalyserNode | null, recording: boolean) => void
  /** Test seam: replaces the real getUserMedia/MediaRecorder capture pipeline. */
  captureImpl?: DictationCaptureStart
}

export function DictationButton({
  disabled,
  onText,
  onError,
  onRecording,
  captureImpl
}: DictationButtonProps): JSX.Element {
  const { t } = useT()
  const [state, setState] = useState<DictationState>('idle')
  const captureRef = useRef<DictationCapture | null>(null)
  // Mounted flag (mirror ChatScreen/DocumentsScreen FE-4): `start()` assigns captureRef only
  // AFTER awaiting getUserMedia, so an unmount while the OS mic prompt is open runs the cleanup
  // FIRST (it sees no capture to release) — then the await resolves a live stream on a dead
  // component. This latch lets the resolved start() release that stream instead of leaking it (F21).
  const mountedRef = useRef(true)

  // lib/dictation stays t-free (a pure module); its canonical mic-blocked English is
  // exact-matched here and localized at display (renderer-ephemeral, never persisted).
  function friendlyCaptureError(e: unknown): string {
    return e instanceof Error && e.message === MIC_BLOCKED_MESSAGE
      ? t('chat.dictation.micBlocked')
      : friendlyIpcError(e)
  }

  // Keep a stable handle to the latest onRecording so the unmount cleanup can call it
  // without re-subscribing the effect (an inline parent callback changes identity every
  // render — making it a dep would tear down the live recording mid-session).
  const onRecordingRef = useRef(onRecording)
  onRecordingRef.current = onRecording

  // Leaving the screen mid-recording must release the microphone (and clear the wave). The
  // mounted latch is dropped FIRST so an in-flight start() that resolves after this sees it.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      captureRef.current?.cancel()
      captureRef.current = null
      onRecordingRef.current?.(null, false)
    }
  }, [])

  async function start(): Promise<void> {
    setState('starting')
    try {
      const capture = await (captureImpl ?? captureDictation)()
      // Unmounted while the mic prompt was open (F21): the cleanup already ran and found no
      // capture to release, so release THIS just-acquired live stream now and touch nothing on
      // the dead component — otherwise the OS recording indicator stays lit until GC.
      if (!mountedRef.current) {
        capture.cancel()
        return
      }
      captureRef.current = capture
      setState('recording')
      onRecording?.(capture.analyser, true)
    } catch (e) {
      captureRef.current = null
      if (!mountedRef.current) return
      setState('idle')
      onError?.(friendlyCaptureError(e))
    }
  }

  async function stopAndTranscribe(): Promise<void> {
    const capture = captureRef.current
    captureRef.current = null
    if (!capture) return
    onRecording?.(null, false)
    setState('transcribing')
    try {
      const bytes = await capture.stop()
      const text = (await window.api.transcribeDictation(bytes)).trim()
      // Unmounted (or navigated to another conversation) while the multi-second transcribe IPC
      // was in flight: let it complete harmlessly but touch nothing on the dead component —
      // firing onText here would set the parent's input AFTER unmount, leaking this dictation
      // into whatever composer is now mounted (a different conversation). Mirrors start()'s F21
      // guard; the parent's mountedRef doesn't gate its setInput, so the gate must live here (F1).
      if (!mountedRef.current) return
      if (text.length === 0) {
        onError?.(t('chat.dictation.noSpeech'))
      } else {
        onText(text)
      }
    } catch (e) {
      if (!mountedRef.current) return
      onError?.(friendlyCaptureError(e))
    } finally {
      if (mountedRef.current) setState('idle')
    }
  }

  const recording = state === 'recording'
  const busy = state === 'starting' || state === 'transcribing'
  const label = recording
    ? t('chat.dictation.stop')
    : state === 'transcribing'
      ? t('chat.dictation.transcribing')
      : t('chat.dictation.start')

  return (
    <Button
      variant="ghost"
      className={`dictation-btn${recording ? ' dictation-recording' : ''}`}
      aria-label={label}
      aria-pressed={recording}
      title={label}
      disabled={disabled || busy}
      onClick={() => {
        if (recording) void stopAndTranscribe()
        else if (state === 'idle') void start()
      }}
    >
      {state === 'transcribing' ? <Spinner /> : <MicIcon />}
    </Button>
  )
}

/** Inline mic glyph (no icon dependency; currentColor follows the button state). */
function MicIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
      <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.08A7 7 0 0 0 19 11z" />
    </svg>
  )
}
