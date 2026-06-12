// Per-message action row (guidelines §3): shown under assistant answers,
// revealed on hover or keyboard focus (CSS — the buttons stay focusable while hidden).
// "Try again" regenerates (last answer, plain chat only), "Copy" copies the answer text,
// "Save" saves the whole conversation. Feedback ("Copied"/"Saved") goes through the
// toast host — the buttons never mutate their own labels.

interface Props {
  /** Omit to hide (only the last assistant answer in a plain chat can regenerate). */
  onTryAgain?: () => void
  onCopy: () => void
  onSave: () => void
  disabled?: boolean
}

export function MessageActions({ onTryAgain, onCopy, onSave, disabled }: Props): JSX.Element {
  return (
    <div className="msg-actions">
      {onTryAgain && (
        <button type="button" className="msg-action" disabled={disabled} onClick={onTryAgain}>
          ↺ Try again
        </button>
      )}
      <button type="button" className="msg-action" disabled={disabled} onClick={onCopy}>
        Copy
      </button>
      <button
        type="button"
        className="msg-action"
        disabled={disabled}
        title="Save this conversation as a file (stays local)"
        onClick={onSave}
      >
        Save
      </button>
    </div>
  )
}
