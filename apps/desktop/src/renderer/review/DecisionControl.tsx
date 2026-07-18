import { useRef } from 'react'
import type { ReviewDecision } from '@shared/types'
import type { I18n } from '../i18n'

// The 6-value review-decision control (EP-1 plan §7.4, spec §14.1): an accessible radio
// group following the SegmentedControl roving-tabindex idiom — only the selected chip is
// tabbable; Arrow keys move focus AND selection, Home/End jump. Rendered as wrapping
// decision CHIPS (spec §11.3): each carries a glyph + text, never color alone
// (guidelines §9). Hand-rolled like SegmentedControl — only dialogs warrant a library.

/** Persisted machine order (spec §14.1) — localized only at render. */
export const DECISION_ORDER: readonly ReviewDecision[] = [
  'supported',
  'partly_supported',
  'not_supported',
  'follow_up',
  'not_reviewed',
  'not_applicable'
]

/** Text glyph per decision — paired with the label, never meaning-bearing alone. */
export const DECISION_GLYPH: Record<ReviewDecision, string> = {
  supported: '✓',
  partly_supported: '◐',
  not_supported: '✗',
  follow_up: '→',
  not_reviewed: '○',
  not_applicable: '—'
}

export function decisionLabelKey(decision: ReviewDecision): `review.decision.${ReviewDecision}` {
  return `review.decision.${decision}`
}

export function DecisionControl({
  value,
  onChange,
  t,
  disabled
}: {
  value: ReviewDecision
  onChange: (value: ReviewDecision) => void
  t: I18n['t']
  disabled?: boolean
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = Math.max(
    0,
    DECISION_ORDER.findIndex((d) => d === value)
  )

  function select(i: number): void {
    refs.current[i]?.focus()
    onChange(DECISION_ORDER[i])
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      select((index + 1) % DECISION_ORDER.length)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      select((index - 1 + DECISION_ORDER.length) % DECISION_ORDER.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      select(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      select(DECISION_ORDER.length - 1)
    }
  }

  return (
    <div role="radiogroup" aria-label={t('review.decision.groupAria')} className="review-decisions">
      {DECISION_ORDER.map((d, i) => (
        <button
          key={d}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={d === value}
          tabIndex={i === selectedIndex ? 0 : -1}
          className={`review-decision-chip ${d === value ? 'selected' : ''}`}
          disabled={disabled}
          onClick={() => onChange(d)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span aria-hidden="true">{DECISION_GLYPH[d]}</span> {t(decisionLabelKey(d))}
        </button>
      ))}
    </div>
  )
}
