// In-app navigation hardening (SEC-3, backend-audit-2026-06-27).
//
// Electron lets renderer content drive the WebContents to a new URL via top-level
// navigation. Production runs `file://` + a strict CSP, so this is defence in depth, but
// the standard hardening is to refuse any navigation the window has no business making.
//
// CRUCIAL: there are TWO events, and BOTH must be guarded. `will-navigate` fires for a
// renderer- or user-initiated navigation; `will-redirect` fires for a server-side (3xx)
// or <meta http-equiv="refresh"> redirect, which can reach a REMOTE origin WITHOUT ever
// firing `will-navigate`. Guarding only `will-navigate` (the prior state) left the
// redirect path on Electron's default (allow). This installer attaches the SAME
// deny-by-default predicate to both, so they can never drift apart.

/**
 * Minimal structural slice of an Electron `WebContents` — its EventEmitter `on`. Structural
 * (not an `electron` import) so the guard is unit-testable under plain vitest, and assignable
 * from the real `WebContents` (which has this EventEmitter overload).
 */
export interface NavigationGuardTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

/** The first argument both navigation events pass — an event we can cancel. */
interface PreventableEvent {
  preventDefault(): void
}

/**
 * Attach a deny-by-default navigation guard to BOTH `will-navigate` AND `will-redirect`
 * (SEC-3) on a WebContents. `isAllowed(url)` returns `true` only for the navigations the
 * window may legitimately perform (e.g. its own `file://` shell in prod, the Vite dev
 * server in dev); every other navigation/redirect is prevented. A worker window that
 * should never navigate at all passes `() => false`.
 */
export function installNavigationGuard(
  target: NavigationGuardTarget,
  isAllowed: (url: string) => boolean
): void {
  const block = (...args: unknown[]): void => {
    const event = args[0] as PreventableEvent | undefined
    const url = typeof args[1] === 'string' ? args[1] : ''
    if (!isAllowed(url)) event?.preventDefault()
  }
  target.on('will-navigate', block)
  target.on('will-redirect', block)
}
