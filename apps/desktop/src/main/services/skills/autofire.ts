import type { Db } from '../db'
import { getSettings } from '../settings'
import { listSkills, getSkill } from './registry'
import { loadSkillPackage } from './loader'
import { selectAutoFire, type SkillCandidate } from './selector'
import { inScopeDocSignals } from './scope-signals'
import { skillNeedsNewerApp } from '../../../shared/skill-manifest'
import type { TurnSkill } from '../chat'
import type { TurnSkillDeps } from './turn'

// resolveAutoFireSkill — the S13b auto-fire decision (skills-s13-plan.md §4, ratified §2.1).
//
// Auto-fire applies the right APP skill to a turn the user left WITHOUT one, saving the tap. It is
// the SAME main-side scope resolution as suggest.ts (the shared `inScopeDocSignals`, §22-C4) and the
// SAME deterministic scoring (`scoreSkillTriggers`), differing only in the gate: a SEPARATE higher
// `AUTOFIRE_SCORE_THRESHOLD` (D2) — structurally "a keyword corroborated by ≥1 doc signal". The
// ratified guards, in order of cost-to-check:
//   D4  the user OPT-IN (`skillsAutoFireEnabled`, DEFAULT FALSE) — a no-op until on, AND app-only.
//   D6  the skill author opted in (`triggers.autoFire`).
//   §6.5 the skill is compatible with the running app (the M1 use-site gate).
//   D2  the score clears `AUTOFIRE_SCORE_THRESHOLD`.
// It is called by resolveTurnSkill ONLY in the branch where a turn has no skill set (D5), so it never
// overrides a sticky default or a per-turn pick. Security is unchanged (§14): candidates are
// enabled-only (content can't introduce a skill); a wrong fire is at worst a worse answer + (S13c)
// a one-click undo. PRIVACY (§6): the question is CONTENT — scored here, NEVER logged or audited
// (the suggest.ts posture); this function returns ids/title/body only and writes to no sink.

/**
 * Resolve the one app skill to AUTO-FIRE for this turn, or null. Returns null (a true no-op) unless
 * the user opted in (D4). `deps.appVersion` drives the §6.5 compatibility gate (absent ⇒ compatible).
 * `question` is the turn's draft text (trimmed here; empty ⇒ no fire).
 */
export function resolveAutoFireSkill(
  db: Db,
  deps: TurnSkillDeps,
  conversationId: string,
  question: string
): TurnSkill | null {
  // D4 opt-in: inert unless the user turned auto-fire on. This is the safe-merge property — with the
  // default-off setting (and no S13c toggle yet), S13b changes nothing in production.
  if (!getSettings(db).skillsAutoFireEnabled) return null
  const q = (question ?? '').trim()
  if (!q) return null

  // Candidates: ENABLED + available + APP-only (D4) + opted-in (D6) + compatible (§6.5/M1). A crafted
  // document can never introduce one (only enabled skills are scored, DS18); app-only narrows further
  // to trusted product skills.
  const candidates: SkillCandidate[] = listSkills(db)
    .filter(
      (s) =>
        s.enabled &&
        s.unavailableAt == null &&
        s.source === 'app' &&
        s.manifest.triggers.autoFire === true &&
        !skillNeedsNewerApp(s.manifest.compatibility.minAppVersion, deps.appVersion ?? '')
    )
    .map((s) => ({ installId: s.installId, title: s.title, triggers: s.manifest.triggers }))
  if (candidates.length === 0) return null

  const { titles, mimeTypes } = inScopeDocSignals(db, conversationId)
  const best = selectAutoFire(candidates, { question: q, docTitles: titles, docMimeTypes: mimeTypes })
  if (!best) return null

  // Load the body the generators need — the SAME path as the explicit resolution (graceful: a body
  // that no longer parses resolves to NO skill, never an error). The glyph then stamps the turn.
  const record = getSkill(db, best.installId)
  if (!record) return null
  const parsed = loadSkillPackage(record, deps)
  if (!parsed.ok || parsed.body == null) return null
  return { installId: record.installId, title: record.title, body: parsed.body }
}
