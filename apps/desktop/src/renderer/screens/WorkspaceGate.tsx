import { useRef, useState } from 'react'
import {
  Banner,
  Button,
  PasswordField,
  PasswordStrengthMeter,
  Progress,
  Spinner,
  Switch,
  passwordStrength
} from '../components'
import { useT } from '../i18n'
import type { ModelVerifyProgress, WorkspaceStateInfo } from '@shared/types'

// The password field + strength meter live in `components/PasswordField`
// (the Settings "Change password" card reuses them); re-exported here so existing
// import sites (tests) stay valid.
export { passwordStrength, type PasswordStrength } from '../components'

// The pre-app gate (spec §7.1 "show onboarding if first run" + unlock). Rendered before
// the normal sidebar whenever the workspace is `uninitialized` or `locked`.
//
// The CREATE path (guidelines §2) is a 3-step guided first run, full-window,
// no nav rail — (1) welcome + trust framing, (2) create the password (show-password
// toggle, honest strength hint that never blocks, paste/password managers work — WCAG
// 3.3.8), (3) an optional starter step that only appears when no AI model is installed
// on the drive. The UNLOCK path stays a single calm screen.
//
// Pre-unlock constraints: settings are unreadable (the gate follows the OS
// theme only, and resolves its LANGUAGE from the localStorage mirror — i18n record
// §3.2), and `listModels` needs an unlocked workspace — so the step-3 check runs
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
  // Live first-run checksum-verification progress (drives the determinate bar in the
  // 'finishing' step). Null until the first event lands — until then the bar is just the
  // calm "Setting things up…" hint.
  const [verifyProgress, setVerifyProgress] = useState<ModelVerifyProgress | null>(null)
  const finished = useRef(false)
  const { t } = useT()

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
    // Subscribe BEFORE the call so no early progress event is missed; the bar stays the
    // calm hint until (and unless) hashing actually starts. `?.` keeps older preloads /
    // test stubs working (they just never drive the bar).
    const unsubscribe = window.api.onModelVerifyProgress?.((p) =>
      setVerifyProgress((prev) => {
        if (prev && prev.runId !== p.runId) return prev // ignore a concurrent pass
        return p.done ? null : p
      })
    )
    try {
      // RT-3: lazy verification on the gate-into-chat path — hash only the active model on
      // a cold cache, not every multi-GB GGUF. The gate only needs to know a chat model is
      // present/usable; the start gate re-verifies the model it actually launches.
      const models = await window.api.listModels(true)
      const hasChatModel = models.some(
        (m) => m.role === 'chat' && (m.state === 'installed' || m.state === 'ready' || m.state === 'running')
      )
      if (finished.current) return
      if (hasChatModel) finish(next, 'chat')
      else setPhase('starter')
    } catch {
      // Whatever went wrong, the workspace is open — never trap the user in the gate.
      finish(next, 'chat')
    } finally {
      unsubscribe?.()
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
      setError(t('gate.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  // Vertical brand lockup (guidelines §7): the diamond sits centered above the edition
  // word so "Lite" reads as part of the mark, not a loose label beside it. The full
  // wordmark stays in the a11y tree (visually hidden) so the brand is announced.
  const brand = (
    <div className="gate-brand">
      <span className="gate-brand-mark" aria-hidden="true">◈</span>
      <span className="gate-brand-edition">HilbertRaum Lite</span>
    </div>
  )

  // ---- Unlock: a single calm screen -------------------------------------------
  if (!creating) {
    return (
      <div className="gate-shell">
        <form className="gate-card card" onSubmit={(e) => void submit(e)}>
          {brand}
          <h1>{t('gate.unlock.title')}</h1>
          <p className="hint">{t('gate.unlock.hint')}</p>
          <div className="gate-fields">
            <PasswordField
              placeholder={t('gate.passwordPlaceholder')}
              value={password}
              autoFocus
              autoComplete="current-password"
              show={showPassword}
              onToggleShow={() => setShowPassword((v) => !v)}
              onChange={setPassword}
              t={t}
            />
          </div>
          {error && <Banner tone="error">{error}</Banner>}
          <Button type="submit" variant="primary" disabled={!canSubmit || busy}>
            {busy ? t('gate.unlock.submitBusy') : t('gate.unlock.submit')}
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
          <h1 className="gate-hero">{t('gate.welcome.title')}</h1>
          <p className="hint">{t('gate.welcome.intro')}</p>
          <p className="hint">
            <strong>{t('gate.welcome.stays')}</strong> {t('gate.welcome.staysRest')}
          </p>
          <Button variant="primary" autoFocus onClick={() => setPhase('password')}>
            {t('gate.welcome.start')}
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'finishing') {
    // Once weight hashing starts (a progress event with real work) the bare spinner gives
    // way to a determinate, byte-weighted bar with a "model N of M" label; before that —
    // and when everything is cached (no events) — the calm hint stays.
    const p = verifyProgress
    const pct =
      p && p.overallBytesTotal > 0
        ? Math.min(100, Math.round((p.overallBytesHashed / p.overallBytesTotal) * 100))
        : null
    return (
      <div className="gate-shell">
        <div className="gate-card card">
          {brand}
          <h1>{t('gate.finishing.title')}</h1>
          {p && pct != null && !p.done ? (
            <Progress
              label={t('gate.finishing.progress', {
                n: p.modelIndex,
                m: p.modelCount,
                name: p.displayName,
                pct
              })}
              value={p.overallBytesHashed}
              max={p.overallBytesTotal}
            />
          ) : (
            <p className="hint">
              <Spinner /> {t('gate.finishing.hint')}
            </p>
          )}
          <Button
            variant="ghost"
            onClick={() => createdState && finish(createdState, 'chat')}
          >
            {t('gate.finishing.skip')}
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
          <h1>{t('gate.starter.title')}</h1>
          <p className="hint">{t('gate.starter.noModel')}</p>
          <p className="hint">{t('gate.starter.optional')}</p>
          <div className="gate-actions">
            <Button variant="ghost" onClick={() => createdState && finish(createdState, 'chat')}>
              {t('gate.starter.skip')}
            </Button>
            <div className="gate-actions-main">
              <Button onClick={() => createdState && finish(createdState, 'documents')}>
                {t('gate.starter.addDocuments')}
              </Button>
              <Button
                variant="primary"
                autoFocus
                onClick={() => createdState && finish(createdState, 'models')}
              >
                {t('gate.starter.chooseModel')}
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
        <h1>{t('gate.create.title')}</h1>
        <p className="hint">{t('gate.create.hint')}</p>

        {state.plaintextAllowed && (
          <Switch
            checked={mode === 'plaintext_dev'}
            onChange={(on) => setMode(on ? 'plaintext_dev' : 'encrypted')}
            label={t('gate.create.plaintextToggle')}
          />
        )}

        {usingPassword && (
          <div className="gate-fields">
            <PasswordField
              placeholder={t('gate.passwordPlaceholder')}
              value={password}
              autoFocus
              autoComplete="new-password"
              show={showPassword}
              onToggleShow={() => setShowPassword((v) => !v)}
              onChange={setPassword}
              t={t}
            />
            {password.length > 0 && <PasswordStrengthMeter strength={strength} t={t} />}
            {strength.hintKey && <p className="hint">{t(strength.hintKey)}</p>}
            <PasswordField
              placeholder={t('gate.create.confirmPlaceholder')}
              value={confirm}
              autoComplete="new-password"
              show={showPassword}
              onChange={setConfirm}
              t={t}
            />
            {confirm.length > 0 && confirm !== password && (
              <p className="hint warn">{t('password.mismatch')}</p>
            )}
          </div>
        )}

        {mode === 'plaintext_dev' && (
          <Banner tone="warning">{t('gate.create.plaintextWarning')}</Banner>
        )}

        {error && <Banner tone="error">{error}</Banner>}

        <div className="gate-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setPhase('welcome')}>
            {t('gate.create.back')}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit || busy}>
            {busy ? t('gate.create.submitBusy') : t('gate.create.submit')}
          </Button>
        </div>
      </form>
    </div>
  )
}
