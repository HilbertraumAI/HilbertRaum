import type { ReactNode } from 'react'

// Empty state (guidelines §6): friendly headline + one line + one primary action.
// Used on Documents, Models, and Chat.

export interface EmptyStateProps {
  title: string
  /** The single explanatory line under the headline. */
  line?: ReactNode
  /** Usually one primary Button (plus optional example chips). */
  action?: ReactNode
}

export function EmptyState({ title, line, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <h2 className="empty-state-title">{title}</h2>
      {line != null && <p className="empty-state-line">{line}</p>}
      {action != null && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
