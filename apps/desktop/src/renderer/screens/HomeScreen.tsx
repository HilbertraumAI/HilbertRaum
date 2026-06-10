import { useEffect, useState } from 'react'
import { Banner, Button } from '../components'
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
        <Banner tone="warning">
          {preflightNotes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
          <p>
            You can still continue. If the app doesn’t open, see the troubleshooting guide in the
            drive’s <strong>docs</strong> folder.
          </p>
        </Banner>
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
        <Button variant="primary" onClick={() => onNavigate('chat')}>
          Start Chat
        </Button>
        <Button onClick={() => onNavigate('documents')}>Import Documents</Button>
        <Button onClick={() => onNavigate('ask-documents')}>Ask My Documents</Button>
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
