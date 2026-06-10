import { useEffect, useState } from 'react'
import { SegmentedControl, Switch, useToast } from '../components'
import { setThemeSetting } from '../theme'
import { PrivacyTab } from './settings/PrivacyTab'
import { DiagnosticsTab } from './settings/DiagnosticsTab'
import type { SettingsTab } from '../navigation'
import type { AppSettings, ThemeSetting } from '@shared/types'

// Settings (Phase 26, guidelines §2): one utility destination with three tabs.
// "General" = the everyday settings; "Privacy & data" absorbs the former Privacy
// screen; "Diagnostics (advanced)" absorbs the former Diagnostics screen. The tab
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
    // Appearance applies immediately (Phase 23) — the saved value, not the request.
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
    </>
  )
}
