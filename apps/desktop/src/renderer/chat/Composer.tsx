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
  /** Attach files to the chat (plan §11.2 net-new intake). Renders a paperclip button when
   *  given; the keyboard-reachable picker fallback for the chat-surface drag/drop target. */
  onAttach?: () => void
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
  dictationCaptureImpl,
  onAttach
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
      {/* One composer unit (guidelines §6): the textarea, optional mic, and Send/Stop
          live inside a single bordered shell that takes the focus ring, so the button
          reads as part of the composer, not a detached control. */}
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
        {onAttach && (
          <button
            type="button"
            className="composer-attach"
            disabled={streaming}
            aria-label={t('chat.attach.button')}
            title={t('chat.attach.button')}
            onClick={onAttach}
          >
            <PaperclipIcon />
          </button>
        )}
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

/** Inline upright paperclip glyph (Material attach_file). An inline SVG — not the 📎
 *  emoji, which Windows renders tilted and mismatched against the SVG mic; currentColor
 *  follows the button's quiet/hover state like MicIcon. */
function PaperclipIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
    </svg>
  )
}
