import type { ReactNode } from 'react'

// Progress (guidelines §6): a determinate bar with a PLAIN label ("Preparing 12 of
// 30…") — no unlabeled spinners on long operations. With unknown totals the bar renders
// indeterminate but the label still says what is happening.

export interface ProgressProps {
  /** Plain-language description of what is in progress. Always visible. */
  label: ReactNode
  /** Current value; omit (with max) for an indeterminate bar. */
  value?: number
  max?: number
}

export function Progress({ label, value, max }: ProgressProps): JSX.Element {
  const determinate = value != null && max != null && max > 0
  return (
    <div className="progress">
      <span className="progress-label">{label}</span>
      {determinate ? <progress value={value} max={max} /> : <progress />}
    </div>
  )
}
