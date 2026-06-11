import { useEffect, useRef, useState } from 'react'
import { Button } from '../components'
import { captureDictation, type DictationCapture, type DictationCaptureStart } from '../lib/dictation'
import { friendlyIpcError } from '../lib/errors'

// Voice dictation (Phase 37, D30): the composer mic. Click to record (the OS mic
// indicator is the recording signal), click again to stop — the audio is resampled
// in-page, transcribed locally by the drive's whisper model, and the text lands in
// the input FOR REVIEW. Nothing is ever auto-sent, and the recording never leaves
// the machine. The button renders only when a transcriber is available
// (availability-driven, D14 precedent — ChatScreen gates on `dictationAvailable`).

/** Friendly notice when the model heard nothing usable (§11.4). */
export const DICTATION_NO_SPEECH_MESSAGE = 'No speech was recognized — try speaking again.'

type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'

interface DictationButtonProps {
  /** Disabled while an answer is streaming (the composer's Send is Stop then). */
  disabled?: boolean
  /** Receives the transcribed text; the composer inserts it at the cursor. */
  onText: (text: string) => void
  /** Friendly failure copy — surfaced by the screen (Banner), like other chat errors. */
  onError?: (message: string) => void
  /** Test seam: replaces the real getUserMedia/MediaRecorder capture pipeline. */
  captureImpl?: DictationCaptureStart
}

export function DictationButton({
  disabled,
  onText,
  onError,
  captureImpl
}: DictationButtonProps): JSX.Element {
  const [state, setState] = useState<DictationState>('idle')
  const captureRef = useRef<DictationCapture | null>(null)

  // Leaving the screen mid-recording must release the microphone.
  useEffect(() => {
    return () => {
      captureRef.current?.cancel()
      captureRef.current = null
    }
  }, [])

  async function start(): Promise<void> {
    setState('starting')
    try {
      captureRef.current = await (captureImpl ?? captureDictation)()
      setState('recording')
    } catch (e) {
      captureRef.current = null
      setState('idle')
      onError?.(friendlyIpcError(e))
    }
  }

  async function stopAndTranscribe(): Promise<void> {
    const capture = captureRef.current
    captureRef.current = null
    if (!capture) return
    setState('transcribing')
    try {
      const bytes = await capture.stop()
      const text = (await window.api.transcribeDictation(bytes)).trim()
      if (text.length === 0) {
        onError?.(DICTATION_NO_SPEECH_MESSAGE)
      } else {
        onText(text)
      }
    } catch (e) {
      onError?.(friendlyIpcError(e))
    } finally {
      setState('idle')
    }
  }

  const recording = state === 'recording'
  const busy = state === 'starting' || state === 'transcribing'
  const label = recording
    ? 'Stop dictation and insert the text'
    : state === 'transcribing'
      ? 'Turning your speech into text'
      : 'Dictate a message'

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
      {state === 'transcribing' ? <span className="spinner" aria-hidden /> : <MicIcon />}
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
