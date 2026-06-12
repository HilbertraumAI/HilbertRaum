// Per-message action row (guidelines §3): shown under assistant answers,
// revealed on hover or keyboard focus (CSS — the buttons stay focusable while hidden).
// "Try again" regenerates (last answer, plain chat only), "Copy" copies the answer text,
// "Save" saves the whole conversation. Feedback ("Copied"/"Saved") goes through the
// toast host — the buttons never mutate their own labels.

import { useT } from '../i18n'

interface Props {
  /** Omit to hide (only the last assistant answer in a plain chat can regenerate). */
  onTryAgain?: () => void
  onCopy: () => void
  onSave: () => void
  disabled?: boolean
}

export function MessageActions({ onTryAgain, onCopy, onSave, disabled }: Props): JSX.Element {
  const { t } = useT()
  return (
    <div className="msg-actions">
      {onTryAgain && (
        <button type="button" className="msg-action" disabled={disabled} onClick={onTryAgain}>
          ↺ {t('chat.actions.tryAgain')}
        </button>
      )}
      <button type="button" className="msg-action" disabled={disabled} onClick={onCopy}>
        {t('chat.actions.copy')}
      </button>
      <button
        type="button"
        className="msg-action"
        disabled={disabled}
        title={t('chat.actions.saveTitle')}
        onClick={onSave}
      >
        {t('chat.actions.save')}
      </button>
    </div>
  )
}
