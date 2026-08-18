import type { PrivacyPolicy } from './types'

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
