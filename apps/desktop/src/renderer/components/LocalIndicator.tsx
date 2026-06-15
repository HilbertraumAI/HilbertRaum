import { useEffect, useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Icon } from './Icon'
import { englishTranslator, type Translator } from './translator'

// Ambient privacy signal (guidelines §1.2/§7): a quiet, persistent state — subtle
// glyph, neutral color, never an alarm. Hover/focus reveals the reassurance
// ("Everything stays on this drive…"); clicking opens Settings → Privacy & data, where
// the full posture is spelled out. When the user has enabled network access for model
// downloads the signal says so honestly (open padlock + "Downloads on") instead of
// pretending to be offline — it reflects the EFFECTIVE state (PolicyStatus.offlineMode),
// so a drive policy that forces downloads off still reads "Offline" even with the
// toggle on.
//
// There is exactly ONE instance app-wide: variant="sidebar" at the foot of the app rail
// (state passed in live by App), visible on every screen (§12.1 #2). The rail is narrow,
// so the sidebar variant shows a SHORT label (the effective state in one word) with the
// full "Local · …" reassurance in the tooltip. The header variant + self-fetching path
// are retained for reuse/tests.

export interface LocalIndicatorProps {
  /** Routes 'settings:privacy' through the app's navigate(). */
  onNavigate: (target: string) => void
  /**
   * Effective offline state (PolicyStatus.offlineMode). Omit to let the component
   * fetch the policy itself on mount; until known it shows the deny-by-default truth.
   */
  offline?: boolean
  variant?: 'header' | 'sidebar'
  /** Bound translate fn for the built-in label/detail (i18n record §5 ⑤); English default. */
  t?: Translator
}

/** The status text (icon + word — never color alone, WCAG 1.4.1). */
export function localIndicatorLabel(offline: boolean, t: Translator = englishTranslator): string {
  return offline ? t('indicator.offline') : t('indicator.online')
}

/** The one-word label for the narrow app rail (full reassurance lives in the tooltip). */
export function localIndicatorShortLabel(
  offline: boolean,
  t: Translator = englishTranslator
): string {
  return offline ? t('indicator.short.offline') : t('indicator.short.online')
}

/** The reassurance line shown on hover/focus (guidelines §7, honest variant). */
export function localIndicatorDetail(offline: boolean, t: Translator = englishTranslator): string {
  return offline ? t('indicator.offlineDetail') : t('indicator.onlineDetail')
}

export function LocalIndicator({
  onNavigate,
  offline,
  variant = 'header',
  t = englishTranslator
}: LocalIndicatorProps): JSX.Element {
  // Self-fetching fallback: deny-by-default (offline) until the policy answers.
  const [fetched, setFetched] = useState(true)
  const controlled = offline !== undefined
  useEffect(() => {
    if (controlled) return
    let active = true
    void (async () => {
      try {
        const p = await window.api?.getPolicy?.()
        if (active && p) setFetched(p.offlineMode)
      } catch {
        if (active) setFetched(true)
      }
    })()
    return () => {
      active = false
    }
  }, [controlled])

  const isOffline = controlled ? offline : fetched
  const sidebar = variant === 'sidebar'
  // The rail shows the short one-word label; the header shows the full "Local · …" form.
  const label = sidebar ? localIndicatorShortLabel(isOffline, t) : localIndicatorLabel(isOffline, t)
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`local-indicator ${sidebar ? 'local-indicator-sidebar' : ''}`}
            // Closed padlock = offline; open padlock = the honest "downloads allowed" state.
            aria-label={label}
            onClick={() => onNavigate('settings:privacy')}
          >
            <Icon name={isOffline ? 'lock' : 'lock-open'} className="local-indicator-icon" />{' '}
            <span className="local-indicator-label">{label}</span>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip" sideOffset={6}>
            {localIndicatorDetail(isOffline, t)}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
