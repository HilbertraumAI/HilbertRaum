import { useEffect, useState } from 'react'
import {
  Banner,
  Button,
  PasswordField,
  PasswordStrengthMeter,
  SegmentedControl,
  Switch,
  passwordStrength,
  useToast
} from '../components'
import { setThemeSetting } from '../theme'
import { PrivacyTab } from './settings/PrivacyTab'
import { DiagnosticsTab } from './settings/DiagnosticsTab'
import type { SettingsTab } from '../navigation'
import type { AppSettings, ThemeSetting } from '@shared/types'

// Settings (guidelines §2): one utility destination with three tabs.
// "General" = the everyday settings; "Privacy & data" and "Diagnostics (advanced)"
// were once standalone screens and now live here as tabs. The tab
// switcher reuses SegmentedControl (roving tabindex + arrow keys, guidelines §6).
// The open tab is owned by App.tsx so navigate('settings:privacy') etc. can land on
// the right tab from anywhere; standalone use (tests) falls back to internal state.

const TAB_CHOICES: Array<{ value: SettingsTab; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'privacy', label: 'Privacy & data' },
  { value: 'diagnostics', label: 'Diagnostics (advanced)' }
]

const THEME_CHOICES: Array<{ value: ThemeSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

export interface SettingsScreenProps {
  /** Controlled tab (App.tsx). Omitted → uncontrolled, starting on General. */
  tab?: SettingsTab
  onTabChange?: (tab: SettingsTab) => void
}

export function SettingsScreen({ tab, onTabChange }: SettingsScreenProps): JSX.Element {
  const [internalTab, setInternalTab] = useState<SettingsTab>('general')
  const activeTab = tab ?? internalTab

  function selectTab(next: SettingsTab): void {
    onTabChange?.(next)
    if (tab === undefined) setInternalTab(next)
  }

  return (
    <div className="screen">
      <h1>Settings</h1>
      <div className="settings-tabs">
        <SegmentedControl
          options={TAB_CHOICES}
          value={activeTab}
          onChange={selectTab}
          ariaLabel="Settings sections"
        />
      </div>
      {activeTab === 'general' && <GeneralTab />}
      {activeTab === 'privacy' && <PrivacyTab />}
      {activeTab === 'diagnostics' && <DiagnosticsTab />}
    </div>
  )
}

// The "General" tab — today's settings, unchanged behavior (network toggle, Appearance,
// Performance, Developer, Workspace facts).
function GeneralTab(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const toast = useToast()

  useEffect(() => {
    window.api?.getSettings().then(setSettings).catch(() => setSettings(null))
  }, [])

  async function patch(p: Partial<AppSettings>): Promise<void> {
    const next = await window.api.updateSettings(p)
    setSettings(next)
    // Appearance applies immediately — the saved value, not the request.
    if (p.theme !== undefined) setThemeSetting(next.theme)
    toast('Saved')
  }

  if (!settings) {
    return <p className="hint">Loading settings…</p>
  }

  return (
    <>
      <div className="card">
        <h2>Privacy &amp; Offline Mode</h2>
        <Switch
          checked={settings.allowNetwork}
          onChange={(on) => void patch({ allowNetwork: on })}
          label="Allow internet access for model downloads and updates"
        />
        <p className="hint">
          Off by default. When off, the app makes no network calls. Turning it on only enables
          model downloads from the AI Model screen — each one asks for confirmation first, and a
          drive policy can keep downloads disabled entirely. Your prompts and documents never
          leave this device regardless of this setting.
        </p>
      </div>

      <div className="card">
        <h2>Appearance</h2>
        <SegmentedControl
          options={THEME_CHOICES}
          value={settings.theme}
          onChange={(theme) => void patch({ theme })}
          ariaLabel="Theme"
        />
        <p className="hint">
          “System” follows your operating system’s light/dark preference. The lock screen
          always follows the system theme.
        </p>
      </div>

      <div className="card">
        <h2>Performance</h2>
        <Switch
          checked={settings.gpuMode === 'auto'}
          onChange={(on) => void patch({ gpuMode: on ? 'auto' : 'off' })}
          label="Use GPU acceleration"
        />
        <p className="hint">
          Uses your graphics card to speed up responses when available. Turn off only if you
          notice stability problems — everything keeps working either way.
        </p>
        <Switch
          checked={settings.autoStartActiveModel}
          onChange={(on) => void patch({ autoStartActiveModel: on })}
          label="Load the selected model automatically when the app starts"
        />
        <p className="hint">
          On by default. The model selected on the AI Model screen is loaded in the background at
          launch (after unlock on encrypted workspaces) so Chat is ready without extra clicks.
        </p>
      </div>

      <div className="card">
        <h2>Developer</h2>
        <Switch
          checked={settings.developerMode}
          onChange={(on) => void patch({ developerMode: on })}
          label="Developer mode (allows plaintext workspace, unverified models)"
        />
        <p className="hint">
          Off by default. Dev builds always count as developer. The drive policy is
          authoritative: on a commercial drive, unverified models stay rejected regardless of
          this setting.
        </p>
      </div>

      <div className="card">
        <h2>Workspace</h2>
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{settings.workspaceMode === 'encrypted' ? 'Encrypted' : 'Plaintext (developer)'}</dd>
          <dt>Context tokens</dt>
          <dd>{settings.contextTokens}</dd>
        </dl>
        <p className="hint">
          {settings.workspaceMode === 'encrypted'
            ? 'This workspace is encrypted at rest. Use “Lock now” in the sidebar to re-encrypt and lock it; it also locks automatically on quit.'
            : 'Plaintext developer workspace — data is stored unencrypted. The encrypted mode is the commercial default.'}
        </p>
      </div>

      {/* Hidden entirely in plaintext_dev mode — there is no password to change. */}
      {settings.workspaceMode === 'encrypted' && <ChangePasswordCard />}
    </>
  )
}

// Settings → "Change password". Reuses the first-run password components
// (strength hint, show toggle — components/PasswordField). The first change of an older
// workspace re-secures every stored document under the new password, which can take a
// while on a big library — the busy copy says so honestly.
function ChangePasswordCard(): JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const strength = passwordStrength(next)
  // The strength meter is advisory; only the 8-character floor + the confirm match
  // (and the main process's own checks) gate submission — the WorkspaceGate rules.
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !busy

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.changeWorkspacePassword(current, next)
      if (result.ok) {
        toast('Password changed')
        setCurrent('')
        setNext('')
        setConfirm('')
      } else {
        setError(result.message)
      }
    } catch {
      setError('Something went wrong. Your current password still works.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>Change password</h2>
      <p className="hint">
        Pick a new password for this workspace. You&apos;ll use it from the next unlock on.
        It can&apos;t be recovered or reset, so choose something you&apos;ll remember.
      </p>
      <div className="gate-fields">
        <PasswordField
          placeholder="Current password"
          autoComplete="current-password"
          value={current}
          show={showPassword}
          onToggleShow={() => setShowPassword((v) => !v)}
          onChange={setCurrent}
        />
        <PasswordField
          placeholder="New password"
          autoComplete="new-password"
          value={next}
          show={showPassword}
          onChange={setNext}
        />
        {next.length > 0 && <PasswordStrengthMeter strength={strength} />}
        {strength.hint && <p className="hint">{strength.hint}</p>}
        <PasswordField
          placeholder="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          show={showPassword}
          onChange={setConfirm}
        />
        {confirm.length > 0 && confirm !== next && (
          <p className="hint warn">Passwords don&apos;t match.</p>
        )}
      </div>
      {busy && (
        <p className="hint" role="status">
          <span className="spinner" /> Securing your documents with the new password… On a
          large library this can take a few minutes.
        </p>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      <Button type="submit" variant="primary" disabled={!canSubmit}>
        {busy ? 'Changing…' : 'Change password'}
      </Button>
    </form>
  )
}
