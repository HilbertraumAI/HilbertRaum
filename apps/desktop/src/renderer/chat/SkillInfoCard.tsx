import type { SkillInfo } from '@shared/types'
import { getSkillInfoKeys } from '@shared/skill-info'
import { useT } from '../i18n'
import { localizedSkillDescription, localizedSkillTitle } from '../lib/skillI18n'

// #46 — the compact skill info card shown when a skill is picked in the composer: what it does,
// what it needs, and its key limitation, said AT the decisive moment instead of discovered
// afterwards (#44 the invisible run button, #45 the surprise .txt output). Shown once per skill
// (ChatScreen persists the seen ids); afterwards the ⓘ next to the picker re-opens it on demand.
//
// Pure + props-driven (the SkillRunBar precedent): ChatScreen owns visibility, persistence and
// navigation; this only renders. An APP skill renders its catalog what/needs/limits lines
// (`shared/skill-info.ts`); a user/unknown skill falls back to its own localized description — the
// app never invents honesty claims about content it didn't author.

export interface SkillInfoCardProps {
  /** The skill the card explains (the active pick). */
  skill: SkillInfo
  /** Hide the card (it stays available behind the picker's ⓘ). */
  onClose: () => void
  /** Open the skill's full detail on the Skills screen ("Learn more"). */
  onLearnMore?: () => void
}

export function SkillInfoCard({ skill, onClose, onLearnMore }: SkillInfoCardProps): JSX.Element {
  const { t, lang } = useT()
  const info = getSkillInfoKeys(skill.id)
  const fallback = localizedSkillDescription(skill, lang)
  return (
    <div className="skill-info-card" role="note" aria-label={t('chat.skill.infoButton', { title: localizedSkillTitle(skill, lang) })}>
      <div className="skill-info-head">
        <strong className="skill-info-title">{localizedSkillTitle(skill, lang)}</strong>
        <button
          type="button"
          className="skill-info-close"
          aria-label={t('chat.skill.info.close')}
          onClick={onClose}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {info ? (
        <>
          <p className="skill-info-line">{t(info.what)}</p>
          <p className="skill-info-line">
            <span className="skill-info-label">{t('chat.skill.info.needsLabel')}</span> {t(info.needs)}
          </p>
          <p className="skill-info-line">
            <span className="skill-info-label">{t('chat.skill.info.limitsLabel')}</span> {t(info.limits)}
          </p>
        </>
      ) : (
        fallback && <p className="skill-info-line">{fallback}</p>
      )}
      <p className="skill-info-foot hint">
        {t('chat.skill.info.perTurn')}
        {onLearnMore && (
          <>
            {' '}
            <button type="button" className="skill-info-more" onClick={onLearnMore}>
              {t('chat.skill.info.learnMore')}
            </button>
          </>
        )}
      </p>
    </div>
  )
}
