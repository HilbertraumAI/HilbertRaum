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
          Off by default. When off, the app makes no network calls. Turning it on only enables
          model downloads from the Models screen — each one asks for confirmation first, and a
          drive policy can keep downloads disabled entirely. Your prompts and documents never
          leave this device regardless of this setting.
        </p>
      </div>

      <div className="card">
        <h2>Performance</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.gpuMode === 'auto'}
            onChange={(e) => patch({ gpuMode: e.target.checked ? 'auto' : 'off' })}
          />
          <span>Use GPU acceleration</span>
        </label>
        <p className="hint">
          Uses your graphics card to speed up responses when available. Turn off only if you
          notice stability problems — everything keeps working either way.
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.autoStartActiveModel}
            onChange={(e) => patch({ autoStartActiveModel: e.target.checked })}
          />
          <span>Load the selected model automatically when the app starts</span>
        </label>
        <p className="hint">
          On by default. The model selected on the Models screen is loaded in the background at
          launch (after unlock on encrypted workspaces) so Chat is ready without extra clicks.
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

      {saving && <p className="hint">Saving…</p>}
    </div>
  )
}
