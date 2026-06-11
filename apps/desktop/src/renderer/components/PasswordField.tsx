import { Button } from './Button'

// Password input + advisory strength meter, extracted from the Phase-27 first-run flow
// (WorkspaceGate) so the Phase-32 Settings "Change password" card reuses the exact same
// behavior instead of duplicating it: paste and password managers always work (no
// onPaste/onDrop interception — WCAG 3.3.8), a Show toggle reveals what was typed, and
// the strength meter is honest and NEVER gates submission.

export interface PasswordStrength {
  /** 0 (empty) … 4 (very strong). Purely advisory — never gates submission. */
  score: 0 | 1 | 2 | 3 | 4
  label: string
  hint: string | null
}

/**
 * Hand-rolled, honest password-strength hint (no external library — fully offline).
 * Length carries most of the weight; character variety adds one step. It is a HINT:
 * only the 8-character floor and the confirm match gate submission.
 */
export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length === 0) return { score: 0, label: '', hint: null }
  if (pw.length < 8) {
    return { score: 1, label: 'Too short', hint: 'Use at least 8 characters.' }
  }
  let score = 1
  if (pw.length >= 12) score += 1
  if (pw.length >= 16) score += 1
  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  if (variety >= 3) score += 1
  const capped = Math.min(score, 4) as 1 | 2 | 3 | 4
  if (capped === 4) return { score: 4, label: 'Very strong', hint: null }
  if (capped === 3) return { score: 3, label: 'Strong', hint: null }
  const hint = 'Longer is stronger — 12 or more characters, or a few unrelated words, work well.'
  if (capped === 2) return { score: 2, label: 'Okay', hint }
  return { score: 1, label: 'Weak', hint }
}

export interface PasswordStrengthMeterProps {
  strength: PasswordStrength
}

/** The 4-segment strength bar + word (never color alone — WCAG 1.4.1). Render only
 *  while the password field is non-empty; the textual hint is the caller's to place. */
export function PasswordStrengthMeter({ strength }: PasswordStrengthMeterProps): JSX.Element {
  return (
    <div className="strength" role="status">
      <span className="strength-bar" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`strength-seg ${i <= strength.score ? `on s${strength.score}` : ''}`}
          />
        ))}
      </span>
      <span className="strength-label">{strength.label}</span>
    </div>
  )
}

export interface PasswordFieldProps {
  placeholder: string
  value: string
  autoFocus?: boolean
  autoComplete: string
  /** Reveal the password (the toggle is shared between sibling fields). */
  show: boolean
  /** Renders the Show/Hide toggle on this field when provided. */
  onToggleShow?: () => void
  onChange: (value: string) => void
}

/**
 * A password input that never fights the user: paste and password managers work (no
 * onPaste/onDrop interception — WCAG 3.3.8) and a Show toggle reveals what was typed.
 */
export function PasswordField({
  placeholder,
  value,
  autoFocus,
  autoComplete,
  show,
  onToggleShow,
  onChange
}: PasswordFieldProps): JSX.Element {
  return (
    <div className="gate-pw-row">
      <input
        type={show ? 'text' : 'password'}
        className="gate-input"
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete={autoComplete}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {onToggleShow && (
        <Button
          size="sm"
          variant="ghost"
          className="gate-pw-toggle"
          aria-pressed={show}
          onClick={onToggleShow}
        >
          {show ? 'Hide' : 'Show'}
        </Button>
      )}
    </div>
  )
}
