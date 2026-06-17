import type { SkillInfo } from '@shared/types'
import type { UiLanguage } from '@shared/i18n'

// Per-locale DISPLAY picking for a skill's title/description (architecture.md "Skills" §16). A skill
// manifest may carry an additive `localized` block (locale → {title, description}); the renderer shows
// the running UI language's entry and falls back to the canonical `title`/`description`. Display only —
// it never changes the prompt/body language (the body stays single-language; the model is multilingual).
//
// Pure + tiny so every surface (composer picker, per-message glyph, Settings cards/detail) localizes
// the same way. Tolerant: a missing block, missing locale, or blank override falls through to canonical.

/** A localizable skill shape — `SkillInfo` and the minimal glyph lookup both satisfy it. */
export interface LocalizableSkill {
  title: string
  description?: string
  localized?: Record<string, { title?: string; description?: string }>
}

/** The displayed title for a skill in the given UI language (canonical fallback). */
export function localizedSkillTitle(skill: LocalizableSkill, lang: UiLanguage): string {
  const override = skill.localized?.[lang]?.title
  return override && override.trim() !== '' ? override : skill.title
}

/** The displayed description for a skill in the given UI language (canonical fallback; '' tolerated). */
export function localizedSkillDescription(skill: LocalizableSkill, lang: UiLanguage): string {
  const override = skill.localized?.[lang]?.description
  return override && override.trim() !== '' ? override : skill.description ?? ''
}

/**
 * Build an installId → localized-title resolver from the loaded skills (for the per-message glyph,
 * which carries only the stamped canonical title + the skill's installId). Falls back to the stamped
 * title when the skill is no longer loaded (e.g. later disabled) — graceful, never blank.
 */
export function skillTitleResolver(
  skills: SkillInfo[],
  lang: UiLanguage
): (installId: string | null | undefined, fallbackTitle: string) => string {
  const byId = new Map(skills.map((s) => [s.installId, s]))
  return (installId, fallbackTitle) => {
    const skill = installId ? byId.get(installId) : undefined
    return skill ? localizedSkillTitle(skill, lang) : fallbackTitle
  }
}
