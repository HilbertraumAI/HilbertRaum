import type { AppSettings, PrivacyPolicy } from './types'

/** The settings keys whose change must re-apply the local-API lifecycle (start/stop/
 *  re-port). Lives beside the shared types so a future localApi* key is added HERE, not
 *  remembered in the IPC handler (review 2026-08-18). */
export const LOCAL_API_SETTINGS_KEYS = [
  'localApiEnabled',
  'localApiPort',
  'localApiTokenRequired'
] as const satisfies readonly (keyof AppSettings)[]

// Local-API shared derivations (local-api wave P2). Lives in shared/ so BOTH processes
// import the same rule: main's start seams (P3) gate the listener on it, and the P4
// Settings card derives its enabled state from it — never a hand re-spelled `a && b`
// that could drift from the spec §3.6 precedence rule.

/** Effective local-API permission: policy ceiling ∧ user setting. The policy can only
 *  restrict — the toggle can never enable what `network.allow_local_api` denies. */
export function localApiEffectivelyEnabled(
  policy: PrivacyPolicy,
  localApiEnabledSetting: boolean
): boolean {
  return policy.network.allowLocalApi && localApiEnabledSetting
}

/**
 * STRICT loopback-hostname classifier for ENFORCEMENT decisions (the local API's Host +
 * Origin checks). Deliberately separate from offlineGuard's `isLoopbackHost`, which is a
 * detection-only helper that over-matches by design (`.localhost` suffixes, absent host
 * ⇒ true — its L-1 comment forbids enforcement reuse). Handles the WHATWG quirk that
 * `URL.hostname` returns IPv6 literals WITH brackets (`[::1]`).
 */
export function isStrictLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}
