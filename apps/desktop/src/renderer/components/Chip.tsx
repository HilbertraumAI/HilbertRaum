import type { ReactNode } from 'react'

// Chip (guidelines §6): --radius-sm, --text-sm; the remove ✕ is revealed on hover/focus
// only (CSS). Used for example prompts and document-scope entries (popover) — never
// permanent chip rows on the canvas.

export interface ChipProps {
  children: ReactNode
  title?: string
  /** When set, renders the hover/focus-revealed remove button. */
  onRemove?: () => void
  /** Accessible name for the remove button (e.g. `Remove contract.pdf`). */
  removeLabel?: string
  disabled?: boolean
  /** Chips can also be actions themselves (e.g. example prompts that fill the composer). */
  onClick?: () => void
}

export function Chip({ children, title, onRemove, removeLabel, disabled, onClick }: ChipProps): JSX.Element {
  const body = <span className="chip-text">{children}</span>
  if (onClick) {
    return (
      <button type="button" className="chip chip-action" title={title} disabled={disabled} onClick={onClick}>
        {body}
      </button>
    )
  }
  return (
    <span className="chip" title={title}>
      {body}
      {onRemove && (
        <button
          type="button"
          className="chip-remove"
          aria-label={removeLabel ?? 'Remove'}
          disabled={disabled}
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </span>
  )
}
