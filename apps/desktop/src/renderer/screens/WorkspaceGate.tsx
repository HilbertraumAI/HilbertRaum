import { useEffect, useRef, useState } from 'react'
import {
  Banner,
  BrandMark,
  Button,
  ErrorBanner,
  PasswordField,
  PasswordStrengthMeter,
  Progress,
  Spinner,
  Switch,
  passwordStrength
} from '../components'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import {
  MIN_PASSWORD_LENGTH,
  type ModelVerifyProgress,
  type WorkspaceActionResult,
  type WorkspaceStateInfo
} from '@shared/types'
import {
  CREATE_FAILURE_KEYS,
  UNLOCK_FAILURE_KEYS,
  startFailureKey,
  type WorkspaceFailureReason
} from '@shared/workspace-failure-keys'

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
  /**
   * #955 item 3: main's state changed under the gate without anything opening: a create was refused as
   * `workspace_exists` (a workspace's key file put back while this create form was up) and main now reads `locked`.
   * The parent shows the gate for the new state, which switches it to its unlock form with the refusal in its banner,
   * so no restart is needed. Not `onUnlocked`: nothing is open, and the first run's landing must not run. Without it
   * the gate re-reads nothing and keeps the refusal on the create form.
   */
  onStateChange?: (next: WorkspaceStateInfo) => void
}

/** Which screen the create flow hands off to. */
type LandOn = 'chat' | 'models' | 'documents'

type CreatePhase = 'welcome' | 'password' | 'finishing' | 'starter'

type Failure = Extract<WorkspaceActionResult, { ok: false }>

// A failed unlock or create renders in the GATE's language (UI-languages owner call D-17 (a)):
// the copy for each `reason` comes from the tables in `shared/workspace-failure-keys.ts`, which
// say why and which test ties them to main's handlers.
function failureText(
  keys: Record<WorkspaceFailureReason, MessageKey | null>,
  failure: Failure,
  t: (key: MessageKey, params?: { min: number }) => string
): string {
  // An own-property read: `reason` comes over IPC, and one naming an inherited member
  // (`toString`, `constructor`) would otherwise resolve to a function and garble the banner.
  const key = Object.hasOwn(keys, failure.reason) ? keys[failure.reason] : null
  // `{ min }` for create's too-short refusal (#807 A2), the floor main refused with; other keys ignore it.
  return key === null ? failure.message : t(key, { min: MIN_PASSWORD_LENGTH })
}

/** The lock screen's banner for each `lockNotice` (#855, #875, #892): what the changes since the last lock were lost
 *  to, or (#911) that the start kept the only copy of the workspace because the encrypted file was missing. */
const LOCK_NOTICE_COPY: Record<NonNullable<WorkspaceStateInfo['lockNotice']>, MessageKey> = {
  working_copy_lost: 'gate.unlock.workingCopyLost',
  session_not_closed: 'gate.unlock.sessionNotClosed',
  session_not_closed_full: 'gate.unlock.sessionNotClosedFull',
  encrypted_file_missing: 'gate.unlock.encryptedFileMissing'
}

/** The banner key for the state's notice, or null. An own-property read, like {@link failureText}'s: the state comes
 *  over IPC. */
function lockNoticeKey(state: WorkspaceStateInfo): MessageKey | null {
  const notice = state.lockNotice
  return notice !== undefined && Object.hasOwn(LOCK_NOTICE_COPY, notice) ? LOCK_NOTICE_COPY[notice] : null
}

export function WorkspaceGate({ state, onUnlocked, onStateChange }: Props): JSX.Element {
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

  // F20 (audit postmerge): the CREATE flow swaps the entire card per `phase`, so focus must
  // be steered to each new step's primary control — otherwise a keyboard / screen-reader user
  // who advances a step is dropped on <body> (worst on `password`, the most security-sensitive
  // step; and `finishing` had no focus target at all). WCAG 2.4.3 / 3.2.2. The welcome CTA
  // keeps its mount-time autoFocus (the initial step); these refs drive every later transition,
  // and — unlike `autoFocus` — re-fire when a step is re-entered (e.g. Back → forward again).
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const finishingSkipRef = useRef<HTMLButtonElement>(null)
  const starterPrimaryRef = useRef<HTMLButtonElement>(null)
  // SH-12 (#145): the UNLOCK field's ref — after a wrong password, `setPassword('')` empties
  // the field and `!canSubmit` disables the submit button focus was sitting on, dead-ending
  // keyboard users (autoFocus fires only at mount). The retry path re-focuses the field.
  const unlockInputRef = useRef<HTMLInputElement>(null)
  // #1024: a back-end start that threw. The card's text goes into the always-mounted alert region two animation frames
  // AFTER the card has mounted, so the empty region is painted first and assistive tech hears the text as a change
  // inside a region that was already there (M-U1, #436); a region inserted already holding its text is missed. An
  // effect alone was not enough: measured in the dev app, the region and its text still landed in the same frame.
  const startFailed = state.state === 'start_failed'
  const startFailureText = startFailed ? t(startFailureKey(state.startFailure)) : null
  const [startError, setStartError] = useState<string | null>(null)
  useEffect(() => {
    if (startFailureText === null) {
      setStartError(null)
      return
    }
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setStartError(startFailureText))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [startFailureText])
  // What "Copy details for support" did, for the status line under it (the gate has no toast host).
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  useEffect(() => {
    if (!creating) return // the UNLOCK path focuses its own field via autoFocus — don't disturb it.
    if (phase === 'password') passwordInputRef.current?.focus()
    else if (phase === 'finishing') finishingSkipRef.current?.focus()
    else if (phase === 'starter') starterPrimaryRef.current?.focus()
    // 'welcome' keeps its CTA autoFocus (initial step).
  }, [phase, creating])

  const usingPassword = !creating || mode === 'encrypted'
  // The strength meter is advisory; only the floor + match (and the main process's own
  // checks) gate submission.
  const canSubmit = creating
    ? mode === 'plaintext_dev'
      ? true
      : password.length >= MIN_PASSWORD_LENGTH && password === confirm
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
    // calm hint until (and unless) hashing actually starts.
    const unsubscribe = window.api.onModelVerifyProgress((p) =>
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
      // FE-E (full-audit-2026-06-29-followup, Phase 8): the workspace IS open, so we never
      // trap the user in the gate — but a genuine listModels/verify FAILURE (a throw, not an
      // empty list) used to drop them silently on Chat's generic "no model" empty state with
      // no explanation. Land them on the Models screen instead so the failure is surfaced
      // once where it's actionable. (An empty list — model genuinely absent — still routes to
      // the 'starter' step above; only a thrown error reaches here.)
      finish(next, 'models')
    } finally {
      unsubscribe()
    }
  }

  /**
   * #955 item 3: after a create refused as `workspace_exists`, re-read main's state. A workspace is on the drive after
   * all (main reads `locked`; its unlock runs the start's steps), so hand the state to the parent, which shows the
   * unlock form; the refusal goes with it, into the error region the two forms share (see the password card below).
   * False (the create form keeps the refusal) without a parent to tell, when the read fails, or when main still reads
   * another state.
   */
  async function switchedToUnlock(refusal: string): Promise<boolean> {
    if (!onStateChange) return false
    let next: WorkspaceStateInfo
    try {
      next = await window.api.getWorkspaceState()
    } catch {
      return false
    }
    if (next?.state !== 'locked') return false
    setError(refusal)
    // Review R F-2: the card keeps its state across the switch, so "Show password" chosen on the create step would
    // leave the other workspace's password field unmasked; the unlock field starts masked, as on any unlock screen.
    setShowPassword(false)
    onStateChange(next)
    return true
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
          const refusal = failureText(CREATE_FAILURE_KEYS, result, t)
          setPassword('')
          setConfirm('')
          if (result.reason === 'workspace_exists' && (await switchedToUnlock(refusal))) return
          setError(refusal)
          passwordInputRef.current?.focus() // SH-12: focus back to the field for the retry
        }
      } else {
        const result = await window.api.unlockWorkspace(password)
        if (result.ok) {
          onUnlocked(result.state)
        } else {
          setError(failureText(UNLOCK_FAILURE_KEYS, result, t))
          setPassword('')
          // SH-12 (#145): without this, focus stays on the now-disabled submit button —
          // combined with a missed announcement the failure was entirely non-obvious to AT.
          unlockInputRef.current?.focus()
        }
      }
    } catch {
      setError(t('gate.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  // Vertical brand lockup (guidelines §7): the sealed-room mark sits centered above the
  // edition word so "Lite" reads as part of the mark, not a loose label beside it. The mark
  // is theme-aware via CSS (gate-safe pre-unlock); the visible "HilbertRaum Lite" edition
  // line announces the brand, so the mark itself stays decorative. The edition line is English in
  // every UI language: CSS uppercases it, and uppercasing follows the language, so under
  // <html lang="tr"> it would read "HİLBERTRAUM LİTE" (second UI-languages wave owner call G-6, 2026-11-13).
  const brand = (
    <div className="gate-brand">
      <BrandMark size={36} />
      <span className="gate-brand-edition" lang="en">HilbertRaum Lite</span>
    </div>
  )

  // ---- #1024: the back end could not start ------------------------------------------
  //
  // Nothing can be unlocked or created in this run: no password field and no primary action (starting the app again is
  // the retry). The cause's text says what helps (a drive that can be written, free space), the code sits on a quiet
  // line (Diagnostics, where codes belong (guidelines §7), cannot be reached from here), and "Copy details for support"
  // copies the session's log lines, the one way they survive the quit of an encrypted workspace. The update plan adds
  // its "Install update from a file…" inside the banner (W-4) for the causes an update can fix.

  // #1024 CR-5: a live region announces a change, and the same text set again is none, so a second press was silent.
  // Each press empties the status first and sets its text two animation frames later, as the banner does: the empty
  // region is painted in between, and every press is heard.
  async function copyDetails(): Promise<void> {
    setCopyStatus(null)
    let status: string
    try {
      const lines = await window.api.getLogTail()
      // Final round: no lines, nothing for support: "Copied" would be untrue, so the clipboard is left as it is.
      const ok = lines.length > 0 && (await window.api.copyToClipboard(lines.join('\n')))
      status = t(ok ? 'diag.copied' : 'diag.copyFailed')
    } catch {
      status = t('diag.copyFailed')
    }
    requestAnimationFrame(() => requestAnimationFrame(() => setCopyStatus(status)))
  }

  if (startFailed) {
    const code = state.startFailure?.code ?? null
    return (
      <div className="gate-shell">
        <div className="gate-card card">
          {brand}
          <h1>{t('app.fatal.title')}</h1>
          {/* SH-2 (#145): always mounted; the text arrives after the mount (the effect above). */}
          <ErrorBanner message={startError} t={t} />
          <p className="hint">{t('gate.startFailed.help')}</p>
          {code !== null && (
            <p className="hint">
              <code>{t('gate.startFailed.code', { code })}</code>
            </p>
          )}
          <div className="gate-start-failed-actions">
            <Button onClick={() => void copyDetails()}>{t('gate.startFailed.copyDetails')}</Button>
            {/* Always mounted, so its first message is announced too. */}
            <p className="hint" role="status">
              {copyStatus ?? ''}
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ---- Create: the first run's welcome, finishing and starter steps ------------

  if (creating && phase === 'welcome') {
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

  if (creating && phase === 'finishing') {
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
            ref={finishingSkipRef}
            variant="ghost"
            onClick={() => createdState && finish(createdState, 'chat')}
          >
            {t('gate.finishing.skip')}
          </Button>
        </div>
      </div>
    )
  }

  if (creating && phase === 'starter') {
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
                ref={starterPrimaryRef}
                variant="primary"
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

  // ---- The password card: the create step (phase 'password') and the unlock screen --------
  //
  // One form for both (#955 item 3, walk round). A create refused because a workspace is on the drive after all
  // switches this card to the unlock screen, and the card keeps its always-mounted error region (SH-2) across the
  // switch, so the refusal arrives as a text change inside a region that was there before (#436, M-U1). A separate
  // unlock form, mounted by the switch, put in a region already holding the text: in the real app its insertion and its
  // text came in the same frame. Each child keeps its slot in both modes, so the DOM of each mode is what it was; the
  // fields are keyed by mode, so the unlock field mounts fresh and takes its `autoFocus` (a reused create field takes
  // none).
  const strength = passwordStrength(password)
  const noticeKey = creating ? null : lockNoticeKey(state)
  return (
    <div className="gate-shell">
      <form className="gate-card card" onSubmit={(e) => void submit(e)}>
        {brand}
        <h1>{creating ? t('gate.create.title') : t('gate.unlock.title')}</h1>
        <p className="hint">{creating ? t('gate.create.hint') : t('gate.unlock.hint')}</p>

        {creating
          ? state.plaintextAllowed && (
              <Switch
                checked={mode === 'plaintext_dev'}
                onChange={(on) => setMode(on ? 'plaintext_dev' : 'encrypted')}
                label={t('gate.create.plaintextToggle')}
              />
            )
          : // #855: a lock finished at the last good snapshot because the working file was gone or
            // damaged. The state carries it until the next unlock: on what that lock returned, and
            // (#875) on getWorkspaceState() at the next start too, from the marker it left. #892: or
            // the start swept the session the app left when it ended without a lock, in words of
            // its own (and with the free-space advice when the drive was too full to lock).
            noticeKey !== null && <Banner tone="warning">{t(noticeKey)}</Banner>}

        {creating ? (
          usingPassword && (
            <div className="gate-fields" key="create-fields">
              <PasswordField
                placeholder={t('gate.passwordPlaceholder')}
                value={password}
                inputRef={passwordInputRef}
                autoComplete="new-password"
                show={showPassword}
                onToggleShow={() => setShowPassword((v) => !v)}
                onChange={setPassword}
                t={t}
              />
              {password.length > 0 && <PasswordStrengthMeter strength={strength} t={t} />}
              {strength.hintKey && <p className="hint">{t(strength.hintKey, strength.hintParams)}</p>}
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
          )
        ) : (
          <div className="gate-fields" key="unlock-fields">
            <PasswordField
              placeholder={t('gate.passwordPlaceholder')}
              value={password}
              autoFocus
              inputRef={unlockInputRef}
              autoComplete="current-password"
              show={showPassword}
              onToggleShow={() => setShowPassword((v) => !v)}
              onChange={setPassword}
              t={t}
            />
          </div>
        )}

        {creating && mode === 'plaintext_dev' && (
          <Banner tone="warning">{t('gate.create.plaintextWarning')}</Banner>
        )}

        {/* SH-2 (#145): always-mounted so the FIRST failure is announced, and kept across the switch above. */}
        <ErrorBanner message={error} t={t} />

        {creating ? (
          <div className="gate-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setPhase('welcome')}>
              {t('gate.create.back')}
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit || busy}>
              {busy ? t('gate.create.submitBusy') : t('gate.create.submit')}
            </Button>
          </div>
        ) : (
          <Button type="submit" variant="primary" disabled={!canSubmit || busy}>
            {busy ? t('gate.unlock.submitBusy') : t('gate.unlock.submit')}
          </Button>
        )}
      </form>
    </div>
  )
}
