import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useT } from '../i18n'
import { localizedSkillDescription, localizedSkillTitle } from '../lib/skillI18n'
import type { SkillInfo, SkillSuggestion } from '@shared/types'

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
  /** A deterministic one-tap suggestion (skills plan §10.2/DS14, S8) — pinned on top when present
   *  and not already selected. An OFFER, never auto-applied. */
  suggestion?: SkillSuggestion | null
  /** Fired when the menu opens/closes — the screen recomputes the suggestion on open. */
  onOpenChange?: (open: boolean) => void
}

export function SkillPicker({
  skills,
  value,
  onChange,
  disabled,
  suggestion,
  onOpenChange
}: SkillPickerProps): JSX.Element {
  const { t, lang } = useT()
  const selected = value ? skills.find((s) => s.installId === value) ?? null : null
  const triggerLabel = selected ? localizedSkillTitle(selected, lang) : t('chat.skill.none')
  // Offer only a suggestion that is real, still enabled, and not already the active pick.
  const offerSkill =
    suggestion && suggestion.installId !== value
      ? skills.find((s) => s.installId === suggestion.installId) ?? null
      : null
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          {t('chat.skill.trigger', { label: triggerLabel })} <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="start" sideOffset={6}>
          {/* The one-tap suggestion rides the picker the user already opened (§22-D3): no canvas
              chip, no settings key. Tapping it sets the skill; it never auto-applies. */}
          {offerSkill && (
            <>
              <DropdownMenu.Item
                className="menu-item skill-suggest"
                onSelect={() => onChange(offerSkill.installId)}
              >
                {t('chat.skill.suggested', { title: localizedSkillTitle(offerSkill, lang) })}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu-sep" />
            </>
          )}
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
                  {localizedSkillTitle(s, lang)}
                  {localizedSkillDescription(s, lang) && (
                    <span className="menu-item-hint">{localizedSkillDescription(s, lang)}</span>
                  )}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
