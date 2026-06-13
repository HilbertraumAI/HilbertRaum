import type { ReactNode } from 'react'
import { englishTranslator, type Translator } from './translator'

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
  /** Bound translate fn for the built-in dismiss label (i18n record §5 ⑤); English default. */
  t?: Translator
}

export function Banner({
  tone = 'info',
  children,
  action,
  onDismiss,
  t = englishTranslator
}: BannerProps): JSX.Element {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="banner-icon" aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      <div className="banner-text">{children}</div>
      {action != null && <div className="banner-action">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          className="banner-dismiss"
          aria-label={t('common.dismiss')}
          onClick={onDismiss}
        >
          ✕
        </button>
      )}
    </div>
  )
}
