import { useEffect, useRef } from 'react'
import { Button, Chip } from '../components'
import { useT } from '../i18n'

// Question composer (§5.3/§5.5): suggestion chips above an auto-grow textarea with one Ask
// button. Enter sends, Shift+Enter inserts a newline (the design-guidelines §6 composer
// convention). A chip FILLS the composer (no auto-send — default per §5.5) so the user can
// edit before asking. Disabled while an analyze is in flight (busy-reject, §9.4).

const MAX_GROW_PX = 180

export interface ComposerChip {
  label: string
  prompt: string
}

export function QuestionComposer({
  value,
  onChange,
  onSend,
  onChip,
  chips,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onChip: (prompt: string) => void
  chips: ComposerChip[]
  /** True while an analyze runs — submit is blocked (a second analyze is busy-rejected). */
  disabled?: boolean
}): JSX.Element {
  const { t } = useT()
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-grow with content, capped (the chat Composer pattern). scrollHeight excludes the
  // border (box-sizing: border-box), so add it back or a 2px overflow shows a phantom bar.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const border = el.offsetHeight - el.clientHeight
    el.style.height = `${Math.min(el.scrollHeight + border, MAX_GROW_PX)}px`
  }, [value])

  const canSend = value.trim().length > 0 && !disabled

  return (
    <div className="image-composer">
      <div className="image-chips" role="group" aria-label={t('images.composer.placeholder')}>
        {chips.map((c) => (
          <Chip key={c.label} onClick={() => onChip(c.prompt)} disabled={disabled} title={c.prompt}>
            {c.label}
          </Chip>
        ))}
      </div>
      <div className="composer-row">
        <div className="chat-input-wrap">
          <textarea
            ref={ref}
            className="chat-input"
            rows={1}
            placeholder={t('images.composer.placeholder')}
            aria-label={t('images.composer.placeholder')}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend) onSend()
              }
            }}
          />
        </div>
        <Button variant="primary" disabled={!canSend} onClick={onSend}>
          {t('images.composer.ask')}
        </Button>
      </div>
    </div>
  )
}
