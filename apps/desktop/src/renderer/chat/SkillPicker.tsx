import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useT } from '../i18n'
import type { SkillInfo } from '@shared/types'

// Composer skill picker (skills plan §10.2 #1 / §15): a quiet footer affordance — "Skill: none ▾"
// — that sets the ONE skill for the next turn AND the conversation's sticky default. Mirrors the
// DepthMenu pattern (footer-menu-btn + Radix RadioGroup). Only ENABLED, available skills appear.
// The S8 "Suggested: …" one-tap offer pins here later; the per-message glyph + "machinery" live
// elsewhere. Selecting "None" clears the skill (value '' = none).

const NONE = ''

interface SkillPickerProps {
  /** Enabled, available skills (already filtered by the screen). */
  skills: SkillInfo[]
  /** The selected skill's installId, or null for none. */
  value: string | null
  onChange: (installId: string | null) => void
  disabled?: boolean
}

export function SkillPicker({ skills, value, onChange, disabled }: SkillPickerProps): JSX.Element {
  const { t } = useT()
  const selected = value ? skills.find((s) => s.installId === value) ?? null : null
  const triggerLabel = selected ? selected.title : t('chat.skill.none')
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          {t('chat.skill.trigger', { label: triggerLabel })} <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="start" sideOffset={6}>
          <DropdownMenu.RadioGroup
            value={value ?? NONE}
            onValueChange={(next) => onChange(next === NONE ? null : next)}
          >
            <DropdownMenu.RadioItem value={NONE} className="menu-item menu-radio">
              <span className="menu-radio-mark" aria-hidden="true">
                <DropdownMenu.ItemIndicator>●</DropdownMenu.ItemIndicator>
              </span>
              <span>{t('chat.skill.none')}</span>
            </DropdownMenu.RadioItem>
            {skills.map((s) => (
              <DropdownMenu.RadioItem
                key={s.installId}
                value={s.installId}
                className="menu-item menu-radio"
              >
                <span className="menu-radio-mark" aria-hidden="true">
                  <DropdownMenu.ItemIndicator>●</DropdownMenu.ItemIndicator>
                </span>
                <span>
                  {s.title}
                  {s.description && <span className="menu-item-hint">{s.description}</span>}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
