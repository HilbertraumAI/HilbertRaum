import { useEffect, useState } from 'react'
import { Banner } from '../components'
import type { AppSettings, DriveStatus, PolicyStatus } from '@shared/types'

// Privacy & Offline Mode screen (spec §7.10 + §18.1). Renders the offline statement
// verbatim, shows where data lives, the live network state (off by default / disabled
// by policy), the plaintext-dev-mode caveat, and the logs-are-local guarantee.

export function PrivacyScreen(): JSX.Element {
  const [policy, setPolicy] = useState<PolicyStatus | null>(null)
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    window.api?.getPolicy().then(setPolicy).catch(() => setPolicy(null))
    window.api?.getDriveStatus().then(setDrive).catch(() => setDrive(null))
    window.api?.getSettings().then(setSettings).catch(() => setSettings(null))
  }, [])

  const offline = policy?.offlineMode ?? true
  // Three states: disabled by policy (hard), off by choice (setting), or allowed.
  const networkState = !policy
    ? 'Offline Mode is on.'
    : !policy.networkAllowedByPolicy
      ? 'Network access disabled by policy.'
      : !policy.allowNetworkSetting
        ? 'Offline Mode is on (network off by default).'
        : 'Internet access is enabled for model downloads and updates.'

  return (
    <div className="screen">
      <h1>Privacy &amp; Offline Mode</h1>

      <div className="card">
        <div className={`offline-statement ${offline ? 'on' : 'off'}`}>
          <strong>{offline ? '● Offline Mode: ON' : '○ Network access enabled'}</strong>
        </div>
        {/* spec §18.1 — verbatim offline statement */}
        <p className="lead" style={{ marginBottom: 8 }}>
          {offline
            ? 'Offline Mode is on. Private AI Drive Lite runs the AI model on your laptop. Your prompts, documents, embeddings, and chat history stay local.'
            : 'Private AI Drive Lite runs the AI model on your laptop. Your prompts, documents, embeddings, and chat history stay local — even with internet access enabled, only model downloads use the network.'}
        </p>
        <p className="hint">
          This app does not send your data to cloud AI providers. There are no prompt, document, or
          embedding uploads, no telemetry, no analytics, and no remote crash reporting.
        </p>
      </div>

      <div className="card">
        <h2>Current network state</h2>
        <p>{networkState}</p>
        <p className="hint">No prompts or files leave this device.</p>
        <dl className="kv">
          <dt>Effective state</dt>
          <dd>{offline ? 'Offline (no network calls)' : 'Network allowed'}</dd>
          <dt>Allowed by policy</dt>
          <dd>{policy ? (policy.networkAllowedByPolicy ? 'Yes' : 'No (disabled by policy)') : '…'}</dd>
          <dt>Your setting</dt>
          <dd>
            {policy
              ? policy.allowNetworkSetting
                ? 'Internet access allowed'
                : 'Off (default)'
              : '…'}
          </dd>
          <dt>Telemetry</dt>
          <dd>Always off (no toggle)</dd>
        </dl>
        <p className="hint">
          The app warns before any network action. The only optional network feature is downloading
          or updating models, which is off by default and must be enabled in Settings. A drive policy
          can disable it entirely.
        </p>
      </div>

      <div className="card">
        <h2>Where your data lives</h2>
        {drive ? (
          <dl className="kv">
            <dt>Drive root</dt>
            <dd>{drive.rootPath}</dd>
            <dt>Workspace</dt>
            <dd>{drive.workspacePath}</dd>
            <dt>Models</dt>
            <dd>{drive.modelsPath}</dd>
            <dt>Logs</dt>
            <dd>{drive.logsPath}</dd>
          </dl>
        ) : (
          <p className="hint">Loading paths…</p>
        )}
        <p className="hint">
          Everything — imported documents, extracted text, embeddings, chat history, generated
          outputs, settings — is stored locally under your workspace. To delete it, remove the
          workspace folder.
        </p>
      </div>

      <div className="card">
        <h2>Local logs only</h2>
        <p className="hint">
          Debug and diagnostic logs are written to a rotating file under the logs folder above and
          are <strong>never uploaded</strong>. Diagnostics does not transmit anything off this device.
        </p>
      </div>

      <div className="card">
        <h2>Workspace protection</h2>
        {settings?.workspaceMode === 'encrypted' ? (
          <p>Your workspace is in <strong>encrypted</strong> mode.</p>
        ) : (
          <>
            <p>
              Your workspace is in <strong>plaintext developer mode</strong>. Files are stored
              unencrypted on the drive for development speed.
            </p>
            <Banner tone="warning">
              Plaintext developer mode is not the commercial default. The encrypted mode —
              password-derived key, nothing stored in plaintext — is what commercial drives use.
              Do not store sensitive documents in plaintext mode on a shared or removable drive.
            </Banner>
          </>
        )}
      </div>
    </div>
  )
}
