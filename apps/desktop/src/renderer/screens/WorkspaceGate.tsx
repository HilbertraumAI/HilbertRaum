import { useState } from 'react'
import type { WorkspaceStateInfo } from '@shared/types'

// The pre-app gate (spec §7.1 "show onboarding if first run" + unlock). Rendered before
// the normal sidebar whenever the workspace is `uninitialized` (create a password) or
// `locked` (enter the password). Calm, non-technical copy (spec §10.1). The password and
// derived key never leave the main process — this screen only sends the typed password.

interface Props {
  state: WorkspaceStateInfo
  onUnlocked: (next: WorkspaceStateInfo) => void
}

/** Tiny, honest password-strength hint (length-based; not a security guarantee). */
function strengthHint(pw: string): string {
  if (pw.length === 0) return ''
  if (pw.length < 8) return 'Too short — use at least 8 characters.'
  if (pw.length < 12) return 'OK. A longer passphrase is stronger.'
  return 'Strong length.'
}

export function WorkspaceGate({ state, onUnlocked }: Props): JSX.Element {
  const creating = state.state === 'uninitialized'
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  // Default to encrypted; only offer plaintext when policy + env allow it.
  const [mode, setMode] = useState<'encrypted' | 'plaintext_dev'>('encrypted')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usingPassword = !creating || mode === 'encrypted'
  const canSubmit = creating
    ? mode === 'plaintext_dev'
      ? true
      : password.length >= 8 && password === confirm
    : password.length > 0

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = creating
        ? await window.api.createWorkspace(password, mode)
        : await window.api.unlockWorkspace(password)
      if (result.ok) {
        onUnlocked(result.state)
      } else {
        setError(result.message)
        setPassword('')
        setConfirm('')
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate-shell">
      <form className="gate-card card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 18 }}>
          <span className="brand-mark">◈</span>
          <div>
            <div className="brand-name">Private AI Drive</div>
            <div className="brand-edition">Lite</div>
          </div>
        </div>

        {creating ? (
          <>
            <h1>Set a workspace password</h1>
            <p className="hint">
              Your documents, chats, and index are encrypted on this drive with a key
              derived from this password. The password is never stored, and there is no
              recovery — choose something you will remember.
            </p>

            {state.plaintextAllowed && (
              <label className="toggle" style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={mode === 'plaintext_dev'}
                  onChange={(e) => setMode(e.target.checked ? 'plaintext_dev' : 'encrypted')}
                />
                <span>Use a plaintext developer workspace (no encryption)</span>
              </label>
            )}
          </>
        ) : (
          <>
            <h1>Unlock your workspace</h1>
            <p className="hint">
              Enter your password to decrypt this drive&apos;s workspace. Everything stays
              on this device.
            </p>
          </>
        )}

        {usingPassword && (
          <div className="gate-fields">
            <input
              type="password"
              className="gate-input"
              placeholder="Password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
            {creating && (
              <>
                <input
                  type="password"
                  className="gate-input"
                  placeholder="Confirm password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                {password.length > 0 && <p className="hint">{strengthHint(password)}</p>}
                {confirm.length > 0 && confirm !== password && (
                  <p className="hint warn">Passwords don&apos;t match.</p>
                )}
              </>
            )}
          </div>
        )}

        {creating && mode === 'plaintext_dev' && (
          <p className="hint warn">
            Plaintext mode stores your data unencrypted on this drive. Use it only for
            development.
          </p>
        )}

        {error && <p className="hint warn">{error}</p>}

        <button type="submit" className="btn primary" disabled={!canSubmit || busy}>
          {busy
            ? creating
              ? 'Creating…'
              : 'Unlocking…'
            : creating
              ? 'Create workspace'
              : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
