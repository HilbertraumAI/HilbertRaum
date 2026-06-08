import { useEffect, useState } from 'react'
import type { AppStatus } from '@shared/types'

interface Props {
  onNavigate: (screen: string) => void
}

export function HomeScreen({ onNavigate }: Props): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    // getAppStatus has no handler until Phase 1; fail gracefully.
    window.api
      ?.getAppStatus()
      .then((s) => active && setStatus(s))
      .catch(() => active && setStatus(null))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="screen">
      <h1>Private AI Drive Lite is ready.</h1>
      <p className="lead">
        A private, offline AI workspace. Your prompts, documents, embeddings, and chat history
        stay on this device.
      </p>

      <div className="status-grid">
        <Stat label="Offline Mode" value={status?.offlineMode === false ? 'Network allowed' : 'ON'} good />
        <Stat label="Active model" value={status?.activeModelId ?? 'Not selected'} />
        <Stat label="Hardware profile" value={status?.hardwareProfile ?? (loading ? '…' : 'Unknown')} />
        <Stat
          label="Workspace"
          value={status?.workspaceMode === 'encrypted' ? 'Encrypted' : 'Plaintext (dev)'}
        />
      </div>

      <div className="actions">
        <button className="btn primary" onClick={() => onNavigate('chat')}>
          Start Chat
        </button>
        <button className="btn" onClick={() => onNavigate('documents')}>
          Import Documents
        </button>
        <button className="btn" onClick={() => onNavigate('documents')}>
          Ask My Documents
        </button>
      </div>

      {!status && !loading && (
        <p className="hint">
          Backend services land in Phase 1 — status will populate once the workspace + settings
          layer is wired.
        </p>
      )}
    </div>
  )
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${good ? 'good' : ''}`}>{value}</div>
    </div>
  )
}
