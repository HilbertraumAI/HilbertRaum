import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from '../components'
import { DictationButton } from './DictationButton'
import { Waveform } from './Waveform'
import { useT } from '../i18n'
import type { DictationCaptureStart } from '../lib/dictation'

// Composer (guidelines §3/§6): auto-growing textarea with ONE action button —
// Send while idle, Stop while streaming (keyboard-reachable either way). Enter sends,
// Shift+Enter inserts a newline. The quiet affordances (answer detail, document scope)
// live in the footer row below the input. Optional dictation mic:
// transcribed speech is INSERTED at the cursor for review — never sent.

const MAX_GROW_PX = 220

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  placeholder: string
  /** "Send" in chat, "Ask" in documents mode. */
  sendLabel: string
  /** Footer affordances: answer-detail dropdown and/or the document-scope popover. */
  footer?: ReactNode
  /** Lets the screen focus the input (example-prompt chips fill it). */
  inputRef?: RefObject<HTMLTextAreaElement>
  /** Voice dictation: the mic renders only when a transcriber exists. */
  dictationAvailable?: boolean
  /** Friendly dictation failure copy — surfaced by the screen like other errors. */
  onDictationError?: (message: string) => void
  /** Test seam forwarded to DictationButton (real getUserMedia capture by default). */
  dictationCaptureImpl?: DictationCaptureStart
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  placeholder,
  sendLabel,
  footer,
  inputRef,
  dictationAvailable,
  onDictationError,
  dictationCaptureImpl
}: ComposerProps): JSX.Element {
  const { t } = useT()
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? ownRef
  // Dictation recording state + the live mic tap. `recording` drives the dim + overlay
  // (true even when Web Audio is unavailable, so the affordance never silently vanishes);
  // `analyser` is null then and Waveform simply draws nothing.
  const [recording, setRecording] = useState(false)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)

  // Auto-grow with content, capped — past the cap the textarea scrolls. scrollHeight
  // excludes the border (box-sizing: border-box), so add it back or a 2px overflow
  // shows a phantom scrollbar.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const border = el.offsetHeight - el.clientHeight
    el.style.height = `${Math.min(el.scrollHeight + border, MAX_GROW_PX)}px`
  }, [value, ref])

  // Insert dictated text at the cursor (replacing a selection), padding with spaces
  // against the neighbours so two dictations never fuse words. Preferred path is
  // execCommand('insertText'): it routes through the editing pipeline, so Ctrl+Z
  // undoes the insert like typed text and React receives a normal input event. The
  // fallback (jsdom / a future removal) splices the value and restores the caret.
  function insertDictation(text: string): void {
    const el = ref.current
    if (!el) {
      onChange(value.length > 0 && !/\s$/.test(value) ? `${value} ${text}` : value + text)
      return
    }
    el.focus()
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const before = el.value.slice(0, start)
    const after = el.value.slice(end)
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
    const insert = lead + text + trail

    el.setSelectionRange(start, end)
    let inserted = false
    try {
      inserted = document.execCommand('insertText', false, insert)
    } catch {
      inserted = false
    }
    if (!inserted) {
      onChange(before + insert + after)
      const caret = start + insert.length
      // After the controlled re-render, put the caret after the inserted text.
      setTimeout(() => {
        ref.current?.setSelectionRange(caret, caret)
      }, 0)
    }
  }

  return (
    <div className="composer">
      <div className={`composer-row${recording ? ' composer-recording' : ''}`}>
        <div className="chat-input-wrap">
          <textarea
            ref={ref}
            className="chat-input"
            rows={1}
            placeholder={placeholder}
            // Accessible name (audit L8): a placeholder is not a label — it vanishes on
            // input and AT support is inconsistent. Mirror the PasswordField pattern and
            // name the field after its mode-specific prompt ("Message…" / "Ask about…").
            aria-label={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!streaming) onSend()
              }
            }}
          />
          {recording && <Waveform analyser={analyser} />}
        </div>
        {dictationAvailable === true && (
          <DictationButton
            disabled={streaming}
            onText={insertDictation}
            onError={onDictationError}
            onRecording={(a, rec) => {
              setAnalyser(a)
              setRecording(rec)
            }}
            captureImpl={dictationCaptureImpl}
          />
        )}
        {streaming ? (
          <Button onClick={onStop}>{t('chat.composer.stop')}</Button>
        ) : (
          <Button variant="primary" disabled={!value.trim()} onClick={onSend}>
            {sendLabel}
          </Button>
        )}
      </div>
      {footer != null && <div className="composer-footer">{footer}</div>}
    </div>
  )
}
