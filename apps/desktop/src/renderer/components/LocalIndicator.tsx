import { useEffect, useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'

// Ambient privacy signal (Phase 27, guidelines §7): a quiet, persistent "Local ·
// Offline" status — subtle glyph, neutral color, never an alarm. Hover/focus reveals
// the reassurance ("Everything stays on this drive…"); clicking opens Settings →
// Privacy & data, where the full posture is spelled out. When the user has enabled
// network access for model downloads the signal says so honestly instead of
// pretending to be offline.
//
// Evolved from the old sidebar offline badge: the same component renders in the
// sidebar (variant="sidebar", state passed in live by App) and in the chat header
// (self-fetching — the screen remounts on navigation, so mount-time policy is fresh).

export interface LocalIndicatorProps {
  /** Routes 'settings:privacy' through the app's navigate(). */
  onNavigate: (target: string) => void
  /**
   * Effective offline state (PolicyStatus.offlineMode). Omit to let the component
   * fetch the policy itself on mount; until known it shows the deny-by-default truth.
   */
  offline?: boolean
  variant?: 'header' | 'sidebar'
}

/** The short status text (icon + word — never color alone, WCAG 1.4.1). */
export function localIndicatorLabel(offline: boolean): string {
  return offline ? 'Local · Offline' : 'Local · Downloads allowed'
}

/** The reassurance line shown on hover/focus (guidelines §7, honest variant). */
export function localIndicatorDetail(offline: boolean): string {
  return offline
    ? 'Everything stays on this drive. No internet connection is used.'
    : 'Downloads allowed — chats and documents stay local.'
}

export function LocalIndicator({ onNavigate, offline, variant = 'header' }: LocalIndicatorProps): JSX.Element {
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
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`local-indicator ${variant === 'sidebar' ? 'local-indicator-sidebar' : ''}`}
            onClick={() => onNavigate('settings:privacy')}
          >
            <span aria-hidden="true">🔒</span> {localIndicatorLabel(isOffline)}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip" sideOffset={6}>
            {localIndicatorDetail(isOffline)}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
