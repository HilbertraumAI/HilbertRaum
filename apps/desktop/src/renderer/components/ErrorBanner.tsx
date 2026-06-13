import type { ReactNode } from 'react'
import { Banner } from './Banner'
import { englishTranslator, type Translator } from './translator'

// ErrorBanner (audit M-U1): assistive tech announces a `role="alert"` reliably only when
// text changes INSIDE an already-present region — inserting a fresh alert element that
// already contains text (the `{error && <Banner role="alert">…</Banner>}` pattern) is
// missed by many screen readers. So the alert container is ALWAYS mounted; the visible
// Banner mounts/unmounts inside it, and the message text swaps within the live region.
// Mirrors the always-mounted Toast host live region.

export interface ErrorBannerProps {
  /** Error text to announce + show. `null`/`''` renders an empty (but mounted) region. */
  message: string | null | undefined
  /** Extra content rendered after the message inside the Banner (e.g. an action Button). */
  children?: ReactNode
  /** When set, renders the Banner's ✕ dismiss button. */
  onDismiss?: () => void
  /** Bound translate fn for the dismiss label (i18n record §5 ⑤); English default. */
  t?: Translator
}

/**
 * An always-mounted `role="alert"` region for error messages. Use in place of the
 * `{error && <Banner tone="error">…</Banner>}` idiom so the message is announced even
 * the first time `message` becomes truthy.
 */
export function ErrorBanner({
  message,
  children,
  onDismiss,
  t = englishTranslator
}: ErrorBannerProps): JSX.Element {
  const show = message != null && message !== ''
  return (
    // The Banner already carries role="alert" for the error tone; the outer wrapper
    // keeps a stable element in the tree across mounts so the swap is what AT hears.
    <div className="error-banner-region" role="alert" aria-live="assertive">
      {show && (
        // Inner Banner is role="status" (not its own alert) — the wrapper owns the
        // single live region so AT doesn't see two competing alert roles.
        <Banner tone="error" role="status" onDismiss={onDismiss} t={t}>
          {message}
          {children}
        </Banner>
      )}
    </div>
  )
}
