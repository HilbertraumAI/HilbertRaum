import { SkillsTab } from './settings/SkillsTab'
import { useT } from '../i18n'

// Skills is a top-level rail destination (no longer a Settings tab). This thin wrapper
// gives it the same screen chrome as the other destinations — a `.screen` frame + an h1 —
// and reuses the existing SkillsTab body unchanged (the list, import flow, detail modal).
export function SkillsScreen(): JSX.Element {
  const { t } = useT()
  return (
    <div className="screen">
      <h1>{t('skills.title')}</h1>
      <SkillsTab />
    </div>
  )
}
