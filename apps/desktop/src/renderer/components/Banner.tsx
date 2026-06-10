import type { ReactNode } from 'react'

// Banner (guidelines §6): persistent, in-context notice — semantic left border + icon +
// text + optional action, optionally dismissible. Errors announce via role="alert";
// everything else is a polite role="status". Never stacked at the top of a screen;
// place a Banner next to the thing it talks about.

export type BannerTone = 'info' | 'success' | 'warning' | 'error'

const TONE_ICON: Record<BannerTone, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '⚠'
}

export interface BannerProps {
  tone?: BannerTone
  children: ReactNode
  /** Optional action rendered after the text (e.g. a small Button). */
  action?: ReactNode
  /** When set, renders a ✕ dismiss button that calls this. */
  onDismiss?: () => void
}

export function Banner({ tone = 'info', children, action, onDismiss }: BannerProps): JSX.Element {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="banner-icon" aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      <div className="banner-text">{children}</div>
      {action != null && <div className="banner-action">{action}</div>}
      {onDismiss && (
        <button type="button" className="banner-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  )
}
