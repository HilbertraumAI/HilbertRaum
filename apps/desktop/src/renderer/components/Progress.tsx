import { useId, type ReactNode } from 'react'

// Progress (guidelines §6): a determinate bar with a PLAIN label ("Preparing 12 of
// 30…") — no unlabeled spinners on long operations. With unknown totals the bar renders
// indeterminate but the label still says what is happening.
//
// SH-10 (#149): the label span is associated via aria-labelledby — it used to be a mere
// visual sibling, so AT announced an ANONYMOUS progressbar at the gate, Models, Chat and
// Documents (the indeterminate branch included).

export interface ProgressProps {
  /** Plain-language description of what is in progress. Always visible. */
  label: ReactNode
  /** Current value; omit (with max) for an indeterminate bar. */
  value?: number
  max?: number
}

export function Progress({ label, value, max }: ProgressProps): JSX.Element {
  const determinate = value != null && max != null && max > 0
  const labelId = useId()
  return (
    <div className="progress">
      <span className="progress-label" id={labelId}>
        {label}
      </span>
      {determinate ? (
        <progress value={value} max={max} aria-labelledby={labelId} />
      ) : (
        <progress aria-labelledby={labelId} />
      )}
    </div>
  )
}
