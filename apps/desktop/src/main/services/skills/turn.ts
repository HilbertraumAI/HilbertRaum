import type { Db } from '../db'
import type { SkillLimits } from './limits'
import { getSkill } from './registry'
import { loadSkillPackage } from './loader'
import { getConversationDefaultSkill, type TurnSkill } from '../chat'

// resolveTurnSkill — the SINGLE place that decides which skill (if any) shapes a turn, shared by
// BOTH chat channels (registerChatIpc + registerRagIpc — audit A1/§22-A1) so a documents
// conversation gets the skill too. Read-only: the sticky default is persisted by the composer via
// setConversationDefaultSkill, not here. Graceful degradation (§10.3): a disabled / deleted /
// unavailable default (or a body that no longer parses) resolves to NO skill, never an error.

export interface TurnSkillDeps {
  appSkillsDir: string
  userSkillsDir: string
  limits?: SkillLimits
}

/**
 * Resolve the one skill for this turn. `requestedInstallId`:
 *   - `undefined` → use the conversation's sticky default (`active_skill_id`).
 *   - `null` / `''` → no skill this turn (an explicit clear for the turn; does NOT touch the default).
 *   - a string → that skill for this turn.
 * Returns the minimal `TurnSkill` (installId + title + body) the generators need, or null.
 */
export function resolveTurnSkill(
  db: Db,
  deps: TurnSkillDeps,
  conversationId: string,
  requestedInstallId?: string | null
): TurnSkill | null {
  const installId =
    requestedInstallId !== undefined
      ? requestedInstallId
      : getConversationDefaultSkill(db, conversationId)
  if (!installId) return null

  const record = getSkill(db, installId)
  // Skip a default that is disabled, deleted, or whose folder vanished (mark-unavailable).
  if (!record || !record.enabled || record.unavailableAt != null) return null

  const parsed = loadSkillPackage(record, deps)
  if (!parsed.ok || parsed.body == null) return null

  return { installId: record.installId, title: record.title, body: parsed.body }
}

/**
 * Convenience wrapper for the IPC layer: resolve the turn skill from the app's `SkillRegistry`
 * handle (or `undefined` when skills aren't wired). Keeps both chat channels (registerChatIpc +
 * registerRagIpc) on the SAME resolution path without each rebuilding the deps (audit A1).
 */
export function resolveTurnSkillFromRegistry(
  db: Db,
  registry: { appSkillsDir: string; userSkillsDir: string } | undefined,
  conversationId: string,
  requestedInstallId?: string | null
): TurnSkill | null {
  if (!registry) return null
  return resolveTurnSkill(
    db,
    { appSkillsDir: registry.appSkillsDir, userSkillsDir: registry.userSkillsDir },
    conversationId,
    requestedInstallId
  )
}
