import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'

export function SettingsScreen(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api?.getSettings().then(setSettings).catch(() => setSettings(null))
  }, [])

  async function patch(p: Partial<AppSettings>): Promise<void> {
    setSaving(true)
    try {
      const next = await window.api.updateSettings(p)
      setSettings(next)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="screen">
        <h1>Settings</h1>
        <p className="hint">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="screen">
      <h1>Settings</h1>

      <div className="card">
        <h2>Privacy &amp; Offline Mode</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.allowNetwork}
            onChange={(e) => patch({ allowNetwork: e.target.checked })}
          />
          <span>Allow internet access for model downloads and updates</span>
        </label>
        <p className="hint">
          Off by default. When off, the app makes no network calls. Your prompts and documents never
          leave this device regardless of this setting.
        </p>
      </div>

      <div className="card">
        <h2>Developer</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.developerMode}
            onChange={(e) => patch({ developerMode: e.target.checked })}
          />
          <span>Developer mode (allows plaintext workspace, unverified models)</span>
        </label>
      </div>

      <div className="card">
        <h2>Workspace</h2>
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{settings.workspaceMode === 'encrypted' ? 'Encrypted' : 'Plaintext (developer)'}</dd>
          <dt>Context tokens</dt>
          <dd>{settings.contextTokens}</dd>
        </dl>
        <p className="hint">Encrypted workspace arrives in Phase 9.</p>
      </div>

      {saving && <p className="hint">Saving…</p>}
    </div>
  )
}
