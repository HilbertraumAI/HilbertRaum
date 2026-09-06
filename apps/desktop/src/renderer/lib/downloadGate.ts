import type { PolicyStatus } from '@shared/types'
import type { Translator } from '../components/translator'

// The network-download gate (guidelines: the drive POLICY is the ceiling, the Settings toggle
// the SWITCH — the copy distinguishes the two, "disabled by policy" vs. "turn it on in
// Settings"). Extracted from `ModelsScreen.tsx` (previously ~498-504, inlined there) so the
// knowledge-pack tools install (#339 P8-2, `useKnowledgePackToolsInstall.ts`) reads the SAME
// gate/copy — two surfaces asking the same yes/no must never diverge.

export interface DownloadGate {
  downloadsEnabled: boolean
  /** Why downloads are blocked, or null when they are allowed. */
  blockedReason: string | null
}

export function computeDownloadGate(policy: PolicyStatus | null, t: Translator): DownloadGate {
  const downloadsAllowedByPolicy = policy?.policy.network.allowModelDownloads ?? false
  const downloadsEnabled = downloadsAllowedByPolicy && (policy?.allowNetworkSetting ?? false)
  const blockedReason = !downloadsAllowedByPolicy
    ? t('models.downloads.blockedByPolicy')
    : !(policy?.allowNetworkSetting ?? false)
      ? t('models.downloads.enableInSettings')
      : null
  return { downloadsEnabled, blockedReason }
}
