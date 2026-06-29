import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from './Button'
import { englishTranslator, type Translator } from './translator'
import type { MessageKey } from '@shared/i18n'

// Password input + advisory strength meter, shared by the first-run flow
// (WorkspaceGate) and the Settings "Change password" card so the behavior stays
// identical: paste and password managers always work (no onPaste/onDrop
// interception — WCAG 3.3.8), a Show toggle reveals what was typed, and the
// strength meter is honest and NEVER gates submission.

export interface PasswordStrength {
  /** 0 (empty) … 4 (very strong). Purely advisory — never gates submission. */
  score: 0 | 1 | 2 | 3 | 4
  /** Strength word as a MessageKey, resolved at render (i18n record §5); null when empty. */
  labelKey: MessageKey | null
  /** Advisory hint as a MessageKey, or null when there is nothing to suggest. */
  hintKey: MessageKey | null
}

/**
 * Hand-rolled, honest password-strength hint (no external library — fully offline).
 * Length carries most of the weight; character variety adds one step. It is a HINT:
 * only the 8-character floor and the confirm match gate submission.
 */
export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length === 0) return { score: 0, labelKey: null, hintKey: null }
  if (pw.length < 8) {
    return { score: 1, labelKey: 'password.strength.tooShort', hintKey: 'password.strength.minHint' }
  }
  let score = 1
  if (pw.length >= 12) score += 1
  if (pw.length >= 16) score += 1
  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  if (variety >= 3) score += 1
  const capped = Math.min(score, 4) as 1 | 2 | 3 | 4
  if (capped === 4) return { score: 4, labelKey: 'password.strength.veryStrong', hintKey: null }
  if (capped === 3) return { score: 3, labelKey: 'password.strength.strong', hintKey: null }
  const hintKey = 'password.strength.longerHint' as const
  if (capped === 2) return { score: 2, labelKey: 'password.strength.okay', hintKey }
  return { score: 1, labelKey: 'password.strength.weak', hintKey }
}

export interface PasswordStrengthMeterProps {
  strength: PasswordStrength
  /** Bound translate fn (i18n record §5 ⑤); English default for provider-less tests. */
  t?: Translator
}

/** Debounce window before the strength word is announced to screen readers. */
const STRENGTH_ANNOUNCE_MS = 600

/** The 4-segment strength bar + word (never color alone — WCAG 1.4.1). Render only
 *  while the password field is non-empty; the textual hint is the caller's to place. */
export function PasswordStrengthMeter({
  strength,
  t = englishTranslator
}: PasswordStrengthMeterProps): JSX.Element {
  // The visible meter is NOT a live region (audit L13): with role="status" it re-announced
  // the strength word on every keystroke (the bar segments change each char). The bar is
  // aria-hidden and the label is plain text; announcement is delegated to a separate
  // sr-only region that updates only after typing pauses (debounced).
  const label = strength.labelKey != null ? t(strength.labelKey) : ''
  return (
    <div className="strength">
      <span className="strength-bar" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`strength-seg ${i <= strength.score ? `on s${strength.score}` : ''}`}
          />
        ))}
      </span>
      <span className="strength-label">{label}</span>
      <DebouncedStrengthAnnouncer label={label} />
    </div>
  )
}

/** sr-only polite region that announces the strength word only after typing settles (L13). */
function DebouncedStrengthAnnouncer({ label }: { label: string }): JSX.Element {
  const [announced, setAnnounced] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnnounced(label), STRENGTH_ANNOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [label])
  return (
    <span className="sr-only" role="status">
      {announced}
    </span>
  )
}

export interface PasswordFieldProps {
  placeholder: string
  value: string
  autoFocus?: boolean
  /** Lets a parent steer focus to this input (WorkspaceGate's per-phase focus — F20). */
  inputRef?: RefObject<HTMLInputElement>
  autoComplete: string
  /** Reveal the password (the toggle is shared between sibling fields). */
  show: boolean
  /** Renders the Show/Hide toggle on this field when provided. */
  onToggleShow?: () => void
  onChange: (value: string) => void
  /** Bound translate fn for the built-in Show/Hide labels (i18n record §5 ⑤). */
  t?: Translator
}

/**
 * A password input that never fights the user: paste and password managers work (no
 * onPaste/onDrop interception — WCAG 3.3.8) and a Show toggle reveals what was typed.
 */
export function PasswordField({
  placeholder,
  value,
  autoFocus,
  inputRef,
  autoComplete,
  show,
  onToggleShow,
  onChange,
  t = englishTranslator
}: PasswordFieldProps): JSX.Element {
  return (
    <div className="gate-pw-field">
      <input
        ref={inputRef}
        type={show ? 'text' : 'password'}
        // Reserve room on the right so typed text never slides under the reveal button.
        className={onToggleShow ? 'gate-input gate-input-with-toggle' : 'gate-input'}
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
          aria-label={show ? t('password.hide') : t('password.show')}
          title={show ? t('password.hide') : t('password.show')}
          onClick={onToggleShow}
        >
          <EyeIcon off={show} />
        </Button>
      )}
    </div>
  )
}

/**
 * Eye / eye-off glyph for the password reveal toggle. Inherits the button's text
 * colour (`currentColor`) so it tracks the theme; decorative only (the Button carries
 * the accessible name via aria-label), so it is hidden from the a11y tree.
 */
function EyeIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}
