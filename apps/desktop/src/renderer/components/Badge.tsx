import type { ReactNode } from 'react'

// Status pill (guidelines §6): --radius-full, --text-xs, ALWAYS icon + word — never a
// color-only dot (WCAG 1.4.1). Tones map to the semantic role tokens; `accent` is for
// in-progress/active states (e.g. "Running").

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'accent'

export interface BadgeProps {
  tone?: BadgeTone
  /** Decorative glyph next to the word (the word carries the meaning). */
  icon?: ReactNode
  title?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', icon, title, children }: BadgeProps): JSX.Element {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {icon != null && (
        <span className="pill-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  )
}
