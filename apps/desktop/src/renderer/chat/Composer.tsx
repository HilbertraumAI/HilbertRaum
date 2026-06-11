import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Button } from '../components'
import { DictationButton } from './DictationButton'
import type { DictationCaptureStart } from '../lib/dictation'

// Composer (Phase 25, guidelines §3/§6): auto-growing textarea with ONE action button —
// Send while idle, Stop while streaming (keyboard-reachable either way). Enter sends,
// Shift+Enter inserts a newline. The quiet affordances (answer detail, document scope)
// live in the footer row below the input. Phase 37 adds the optional dictation mic:
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
  /** Voice dictation (Phase 37): the mic renders only when a transcriber exists. */
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
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? ownRef

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
      <div className="composer-row">
        <textarea
          ref={ref}
          className="chat-input"
          rows={1}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!streaming) onSend()
            }
          }}
        />
        {dictationAvailable === true && (
          <DictationButton
            disabled={streaming}
            onText={insertDictation}
            onError={onDictationError}
            captureImpl={dictationCaptureImpl}
          />
        )}
        {streaming ? (
          <Button onClick={onStop}>Stop</Button>
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
