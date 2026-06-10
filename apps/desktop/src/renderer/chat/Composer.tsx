import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Button } from '../components'

// Composer (Phase 25, guidelines §3/§6): auto-growing textarea with ONE action button —
// Send while idle, Stop while streaming (keyboard-reachable either way). Enter sends,
// Shift+Enter inserts a newline. The quiet affordances (answer detail, document scope)
// live in the footer row below the input.

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
  inputRef
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
