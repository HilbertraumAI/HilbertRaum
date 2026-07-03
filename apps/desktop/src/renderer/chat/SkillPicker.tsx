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
  /** U-3: the user explicitly declined the suggestion for this draft (picked "None"). Suppresses the
   *  CLOSED-trigger hint so it never re-nags — the in-picker pinned offer is unaffected. */
  suggestionDismissed?: boolean
  /** U3 (audit §4.3): clear the active skill — the persistent composer chip's ×. Clears BOTH the
   *  per-turn pick and any saved conversation default. Rendered only when a skill is active. */
  onClear?: () => void
  /** U3: whether the active pick is saved as this conversation's DEFAULT (survives reload). Drives the
   *  in-picker "Keep for this conversation" checkbox. A pick is per-turn until this opts in. */
  keptForConversation?: boolean
  /** U3: toggle whether the active pick is saved as the conversation default (explicit, not implicit). */
  onKeepChange?: (keep: boolean) => void
}

export function SkillPicker({
  skills,
  value,
  onChange,
  disabled,
  suggestion,
  onOpenChange,
  suggestionDismissed,
  onClear,
  keptForConversation,
  onKeepChange
}: SkillPickerProps): JSX.Element {
  const { t, lang } = useT()
  const selected = value ? skills.find((s) => s.installId === value) ?? null : null
  const triggerLabel = selected ? localizedSkillTitle(selected, lang) : t('chat.skill.none')
  // Offer only a suggestion that is real, still enabled, and not already the active pick.
  const offerSkill =
    suggestion && suggestion.installId !== value
      ? skills.find((s) => s.installId === suggestion.installId) ?? null
      : null
  // U-3: when NO skill is picked and the offer was not declined, surface that same offer as a quiet,
  // named affordance on the CLOSED trigger so a user who never opens the picker still sees it. It
  // sits OUTSIDE the dropdown, so one tap SELECTS the skill (it never opens the menu) — still an
  // inert offer the user taps (§22-D3: no canvas chip, no settings key, never auto-applied).
  const closedHintSkill = value == null && !suggestionDismissed ? offerSkill : null
  return (
    <>
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
          {/* U3 (audit §4.3): a pick is PER-TURN by default; this checkbox is the explicit opt-in to
              save it as the conversation's default (survives reload). Shown only when a skill is
              active — "keep None" is meaningless. Toggling off drops only the saved default; the skill
              stays active for the session (the screen keeps it as a per-turn pick). */}
          {selected && onKeepChange && (
            <>
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.CheckboxItem
                className="menu-item menu-check skill-keep"
                checked={keptForConversation ?? false}
                onCheckedChange={(next) => onKeepChange(next === true)}
                onSelect={(e) => e.preventDefault() /* keep the menu open on toggle */}
              >
                <span className="menu-radio-mark" aria-hidden="true">
                  <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
                </span>
                <span>{t('chat.skill.keep')}</span>
              </DropdownMenu.CheckboxItem>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {/* U3 (audit §4.3): the persistent composer chip's × — always visible while a skill is active, so
        the user can SEE which skill shapes their turns and clear it in one tap (override + saved
        default) without hunting inside the menu. */}
    {selected && onClear && (
      <button
        type="button"
        className="footer-menu-btn skill-chip-clear"
        disabled={disabled}
        aria-label={t('chat.skill.clear', { title: localizedSkillTitle(selected, lang) })}
        onClick={onClear}
      >
        <span aria-hidden="true">✕</span>
      </button>
    )}
    {closedHintSkill && (
      <button
        type="button"
        className="footer-menu-btn skill-suggest-hint"
        disabled={disabled}
        onClick={() => onChange(closedHintSkill.installId)}
      >
        {t('chat.skill.suggestedHint', { title: localizedSkillTitle(closedHintSkill, lang) })}
      </button>
    )}
    </>
  )
}
