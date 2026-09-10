import type { ReactNode } from 'react'
import { englishTranslator, type Translator } from './translator'

// Banner (guidelines §6): persistent, in-context notice — semantic left border + icon +
// text + optional action, optionally dismissible. Errors announce via role="alert";
// everything else is a polite role="status". Never stacked at the top of a screen;
// place a Banner next to the thing it talks about.
//
// A Banner rendered INSIDE an already-mounted live region (ErrorBanner, the ModelsScreen
// download panel) must pass `role={null}` — see the role prop below and issue #436.

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
  /**
   * Override the announce role. Defaults to `alert` for the error tone, `status` otherwise.
   *
   * `null` renders NO role attribute — the only correct value when this Banner is nested inside
   * an already-mounted live region. `role="status"` is ITSELF a live region (implicit
   * `aria-live="polite"`), so a nested `status` becomes the nearest live-region ancestor of the
   * message AND is inserted already containing it — the very M-U1 anti-pattern the wrapper exists
   * to prevent. Verified by ear with Narrator (#436): a nested `status` is silent, `aria-live="off"`
   * on it does NOT rescue it, and only removing the role outright announces.
   */
  role?: 'alert' | 'status' | null
}

export function Banner({
  tone = 'info',
  children,
  action,
  onDismiss,
  t = englishTranslator,
  role
}: BannerProps): JSX.Element {
  return (
    <div
      className={`banner banner-${tone}`}
      // Prop omitted (`undefined`) ⇒ the tone default; an explicit `null` ⇒ no role at all.
      role={role === null ? undefined : (role ?? (tone === 'error' ? 'alert' : 'status'))}
    >
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
