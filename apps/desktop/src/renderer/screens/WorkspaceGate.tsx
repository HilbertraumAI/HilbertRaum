import { useRef, useState } from 'react'
import { Banner, Button, Switch } from '../components'
import type { WorkspaceStateInfo } from '@shared/types'

// The pre-app gate (spec §7.1 "show onboarding if first run" + unlock). Rendered before
// the normal sidebar whenever the workspace is `uninitialized` or `locked`.
//
// Phase 27 (guidelines §2): the CREATE path is a 3-step guided first run, full-window,
// no nav rail — (1) welcome + trust framing, (2) create the password (show-password
// toggle, honest strength hint that never blocks, paste/password managers work — WCAG
// 3.3.8), (3) an optional starter step that only appears when no AI model is installed
// on the drive. The UNLOCK path stays a single calm screen.
//
// Pre-unlock constraints: settings are unreadable (D-UI2 — the gate follows the OS
// theme only), and `listModels` needs an unlocked workspace — so the step-3 check runs
// AFTER create succeeds, before handing off to the shell. The password and derived key
// never leave the main process — this screen only sends the typed password.

interface Props {
  state: WorkspaceStateInfo
  /**
   * Called when the workspace is open. `landOn` is the screen the first-run flow ends
   * on ('chat' = the teaching empty state; step 3 may pick 'models'/'documents');
   * omitted on a plain unlock.
   */
  onUnlocked: (next: WorkspaceStateInfo, landOn?: string) => void
}

export interface PasswordStrength {
  /** 0 (empty) … 4 (very strong). Purely advisory — never gates submission. */
  score: 0 | 1 | 2 | 3 | 4
  label: string
  hint: string | null
}

/**
 * Hand-rolled, honest password-strength hint (no external library — fully offline).
 * Length carries most of the weight; character variety adds one step. It is a HINT:
 * only the 8-character floor and the confirm match gate the Create button.
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

/** Which screen the create flow hands off to. */
type LandOn = 'chat' | 'models' | 'documents'

type CreatePhase = 'welcome' | 'password' | 'finishing' | 'starter'

export function WorkspaceGate({ state, onUnlocked }: Props): JSX.Element {
  const creating = state.state === 'uninitialized'
  const [phase, setPhase] = useState<CreatePhase>('welcome')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  // Default to encrypted; only offer plaintext when policy + env allow it.
  const [mode, setMode] = useState<'encrypted' | 'plaintext_dev'>('encrypted')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set once create succeeds; the starter step hands it to the shell.
  const [createdState, setCreatedState] = useState<WorkspaceStateInfo | null>(null)
  const finished = useRef(false)

  const usingPassword = !creating || mode === 'encrypted'
  // The strength meter is advisory; only the floor + match (and the main process's own
  // checks) gate submission.
  const canSubmit = creating
    ? mode === 'plaintext_dev'
      ? true
      : password.length >= 8 && password === confirm
    : password.length > 0

  function finish(next: WorkspaceStateInfo, landOn: LandOn): void {
    if (finished.current) return
    finished.current = true
    onUnlocked(next, landOn)
  }

  // Step-3 gate: only show the starter step when NO chat model is installed on the
  // drive (commercial drives ship one preinstalled — they skip straight to Chat). The
  // first look at a multi-GB model file hashes it, which can take a while — the
  // "finishing" phase says so and stays skippable.
  async function completeCreate(next: WorkspaceStateInfo): Promise<void> {
    setCreatedState(next)
    setPhase('finishing')
    try {
      const models = await window.api.listModels()
      const hasChatModel = models.some(
        (m) => m.role === 'chat' && (m.state === 'installed' || m.state === 'ready' || m.state === 'running')
      )
      if (finished.current) return
      if (hasChatModel) finish(next, 'chat')
      else setPhase('starter')
    } catch {
      // Whatever went wrong, the workspace is open — never trap the user in the gate.
      finish(next, 'chat')
    }
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      if (creating) {
        const result = await window.api.createWorkspace(password, mode)
        if (result.ok) {
          await completeCreate(result.state)
        } else {
          setError(result.message)
          setPassword('')
          setConfirm('')
        }
      } else {
        const result = await window.api.unlockWorkspace(password)
        if (result.ok) {
          onUnlocked(result.state)
        } else {
          setError(result.message)
          setPassword('')
        }
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const brand = (
    <div className="brand" style={{ marginBottom: 18 }}>
      <span className="brand-mark">◈</span>
      <div>
        <div className="brand-name">Private AI Drive</div>
        <div className="brand-edition">Lite</div>
      </div>
    </div>
  )

  // ---- Unlock: a single calm screen -------------------------------------------
  if (!creating) {
    return (
      <div className="gate-shell">
        <form className="gate-card card" onSubmit={(e) => void submit(e)}>
          {brand}
          <h1>Unlock your workspace</h1>
          <p className="hint">
            Enter your password to open this drive&apos;s workspace. Everything stays on
            this drive.
          </p>
          <div className="gate-fields">
            <PasswordField
              placeholder="Password"
              value={password}
              autoFocus
              autoComplete="current-password"
              show={showPassword}
              onToggleShow={() => setShowPassword((v) => !v)}
              onChange={setPassword}
            />
          </div>
          {error && <Banner tone="error">{error}</Banner>}
          <Button type="submit" variant="primary" disabled={!canSubmit || busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </form>
      </div>
    )
  }

  // ---- Create: the 3-step first run --------------------------------------------

  if (phase === 'welcome') {
    return (
      <div className="gate-shell">
        <div className="gate-card card">
          {brand}
          <h1 className="gate-hero">Welcome</h1>
          <p className="hint">
            This is your private AI workspace. Chat with an AI model and ask questions
            about your documents — it all runs from this drive.
          </p>
          <p className="hint">
            <strong>Everything stays on this drive.</strong> No internet, no account, no
            tracking.
          </p>
          <Button variant="primary" autoFocus onClick={() => setPhase('password')}>
            Get started
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'finishing') {
    return (
      <div className="gate-shell">
        <div className="gate-card card">
          {brand}
          <h1>Setting things up…</h1>
          <p className="hint">
            <span className="spinner" /> Checking what&apos;s already on this drive. The
            first look at a large AI model file can take a few minutes.
          </p>
          <Button
            variant="ghost"
            onClick={() => createdState && finish(createdState, 'chat')}
          >
            Skip — take me to the app
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'starter') {
    return (
      <div className="gate-shell">
        <div className="gate-card card">
          {brand}
          <h1>One last thing</h1>
          <p className="hint">
            No AI model is installed on this drive yet — chat needs one to answer. You
            can add one now, or any time later from the AI Model screen.
          </p>
          <p className="hint">
            Downloading a model is optional and always asks for your confirmation first.
            Your documents and chats never use the internet either way.
          </p>
          <div className="gate-actions">
            <Button variant="ghost" onClick={() => createdState && finish(createdState, 'chat')}>
              Skip for now
            </Button>
            <div className="gate-actions-main">
              <Button onClick={() => createdState && finish(createdState, 'documents')}>
                Add documents
              </Button>
              <Button
                variant="primary"
                autoFocus
                onClick={() => createdState && finish(createdState, 'models')}
              >
                Choose your AI model
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // phase === 'password'
  const strength = passwordStrength(password)
  return (
    <div className="gate-shell">
      <form className="gate-card card" onSubmit={(e) => void submit(e)}>
        {brand}
        <h1>Create your password</h1>
        <p className="hint">
          This password locks everything in your workspace — documents, chats, and
          notes — on this drive. It can&apos;t be recovered or reset, so pick something
          you&apos;ll remember.
        </p>

        {state.plaintextAllowed && (
          <Switch
            checked={mode === 'plaintext_dev'}
            onChange={(on) => setMode(on ? 'plaintext_dev' : 'encrypted')}
            label="Use a plaintext developer workspace (no encryption)"
          />
        )}

        {usingPassword && (
          <div className="gate-fields">
            <PasswordField
              placeholder="Password"
              value={password}
              autoFocus
              autoComplete="new-password"
              show={showPassword}
              onToggleShow={() => setShowPassword((v) => !v)}
              onChange={setPassword}
            />
            {password.length > 0 && (
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
            )}
            {strength.hint && <p className="hint">{strength.hint}</p>}
            <PasswordField
              placeholder="Confirm password"
              value={confirm}
              autoComplete="new-password"
              show={showPassword}
              onChange={setConfirm}
            />
            {confirm.length > 0 && confirm !== password && (
              <p className="hint warn">Passwords don&apos;t match.</p>
            )}
          </div>
        )}

        {mode === 'plaintext_dev' && (
          <Banner tone="warning">
            Plaintext mode stores your data unencrypted on this drive. Use it only for
            development.
          </Banner>
        )}

        {error && <Banner tone="error">{error}</Banner>}

        <div className="gate-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setPhase('welcome')}>
            Back
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit || busy}>
            {busy ? 'Creating…' : 'Create workspace'}
          </Button>
        </div>
      </form>
    </div>
  )
}

interface PasswordFieldProps {
  placeholder: string
  value: string
  autoFocus?: boolean
  autoComplete: string
  /** Reveal the password (the toggle is shared between the two create fields). */
  show: boolean
  /** Renders the Show/Hide toggle on this field when provided. */
  onToggleShow?: () => void
  onChange: (value: string) => void
}

/**
 * A password input that never fights the user: paste and password managers work (no
 * onPaste/onDrop interception — WCAG 3.3.8) and a Show toggle reveals what was typed.
 */
function PasswordField({
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
