import type { Db } from '../db'
import type { SkillLimits } from './limits'
import { getSkill } from './registry'
import { loadSkillPackage } from './loader'
import { resolveAutoFireSkill } from './autofire'
import { skillNeedsNewerApp } from '../../../shared/skill-manifest'
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
  /**
   * The running app version, for the §6.5 minAppVersion gate (§14/M1). Gating the USE-SITE (not just
   * enable) keeps the gate airtight: a skill edited on disk to need a newer app while already enabled
   * is skipped here regardless of its stale `enabled` flag. Absent / '' ⇒ treated as compatible.
   */
  appVersion?: string
}

/**
 * Resolve the one skill for this turn. `requestedInstallId`:
 *   - `undefined` → use the conversation's sticky default (`active_skill_id`).
 *   - `null` / `''` → no skill this turn (an explicit clear for the turn; does NOT touch the default).
 *   - a string → that skill for this turn.
 * `question` is the turn's draft text — passed ONLY so the §22 single-resolution path can offer an
 * S13b AUTO-FIRE when (and only when) the turn has no skill set (D5). It is CONTENT: scored, never
 * logged. Returns the minimal `TurnSkill` (installId + title + body) the generators need, or null.
 */
export function resolveTurnSkill(
  db: Db,
  deps: TurnSkillDeps,
  conversationId: string,
  requestedInstallId?: string | null,
  question?: string
): TurnSkill | null {
  const installId =
    requestedInstallId !== undefined
      ? requestedInstallId
      : getConversationDefaultSkill(db, conversationId)
  if (!installId) {
    // D5: the turn has NO skill set. Auto-fire may fill ONLY this gap — and only when the caller made
    // no per-turn pick (`requestedInstallId === undefined`): an explicit per-turn clear (null/'') is a
    // deliberate "no skill" choice and is respected. Off by default (the D4 opt-in inside
    // resolveAutoFireSkill), so this is a no-op in production until S13c.
    if (requestedInstallId === undefined && question) {
      return resolveAutoFireSkill(db, deps, conversationId, question)
    }
    return null
  }

  const record = getSkill(db, installId)
  // Skip a default that is disabled, deleted, or whose folder vanished (mark-unavailable).
  if (!record || !record.enabled || record.unavailableAt != null) return null
  // §6.5/M1 gate at the use-site: skip a skill that now needs a newer app even if its `enabled` flag
  // is stale (edited on disk after it was enabled). Reuses the shared, version-tolerant helper.
  if (skillNeedsNewerApp(record.manifest.compatibility.minAppVersion, deps.appVersion ?? '')) return null

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
  registry: { appSkillsDir: string; userSkillsDir: string; appVersion?: string } | undefined,
  conversationId: string,
  requestedInstallId?: string | null,
  question?: string
): TurnSkill | null {
  if (!registry) return null
  return resolveTurnSkill(
    db,
    {
      appSkillsDir: registry.appSkillsDir,
      userSkillsDir: registry.userSkillsDir,
      appVersion: registry.appVersion
    },
    conversationId,
    requestedInstallId,
    question
  )
}
