import { useEffect, useState } from 'react'
import type { AppStatus, PreflightResult } from '@shared/types'

interface Props {
  onNavigate: (screen: string) => void
}

export function HomeScreen({ onNavigate }: Props): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)

  useEffect(() => {
    let active = true
    // getAppStatus has no handler until Phase 1; fail gracefully.
    window.api
      ?.getAppStatus()
      .then((s) => active && setStatus(s))
      .catch(() => active && setStatus(null))
      .finally(() => active && setLoading(false))
    // Phase 13: friendly, non-blocking launch preflight (drive writable / space / speed).
    window.api
      ?.runPreflight?.()
      .then((p) => active && setPreflight(p))
      .catch(() => active && setPreflight(null))
    return () => {
      active = false
    }
  }, [])

  const preflightNotes = preflight
    ? [...preflight.problems, ...(preflight.slowDriveWarning ? [preflight.slowDriveWarning] : [])]
    : []

  return (
    <div className="screen">
      <h1>Private AI Drive Lite is ready.</h1>
      <p className="lead">
        A private, offline AI workspace. Your prompts, documents, embeddings, and chat history
        stay on this device.
      </p>

      {preflightNotes.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }} role="status">
          {preflightNotes.map((note, i) => (
            <p key={i} className="hint warn" style={{ margin: i === 0 ? 0 : '6px 0 0' }}>
              {note}
            </p>
          ))}
          <p className="hint" style={{ margin: '6px 0 0' }}>
            You can still continue. If the app doesn’t open, see the troubleshooting guide in the
            drive’s <strong>docs</strong> folder.
          </p>
        </div>
      )}

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
