import { useEffect, useState } from 'react'
import { Badge, Banner, Button } from '../components'
import type { AppStatus, DocumentInfo, PreflightResult, RuntimeStatus } from '@shared/types'

interface Props {
  onNavigate: (screen: string) => void
}

// Home as a readiness hub (guidelines §2): answers "is everything ready?"
// at a glance — workspace state, model running?, document count — with ONE primary
// action ("Start chatting") and quiet preflight warnings. Reuses existing IPC only
// (getAppStatus / getRuntimeStatus / listDocuments / runPreflight).

/** Matches the ChatScreen no-model poll: Home flips to "ready" by itself. */
const RUNTIME_POLL_MS = 2500

export function HomeScreen({ onNavigate }: Props): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)

  useEffect(() => {
    let active = true
    window.api
      ?.getAppStatus()
      .then((s) => active && setStatus(s))
      .catch(() => active && setStatus(null))
    window.api
      ?.listDocuments()
      .then((d) => active && setDocs(d ?? []))
      .catch(() => active && setDocs([]))
    // Friendly, non-blocking launch preflight (drive writable / space / speed).
    window.api
      ?.runPreflight?.()
      .then((p) => active && setPreflight(p))
      .catch(() => active && setPreflight(null))
    return () => {
      active = false
    }
  }, [])

  // The selected model auto-starts in the background at launch — poll so the model
  // row flips to "running" without a manual refresh (same cadence as ChatScreen).
  useEffect(() => {
    let active = true
    const check = (): void => {
      window.api
        ?.getRuntimeStatus()
        .then((r) => active && setRuntime(r))
        .catch(() => active && setRuntime(null))
    }
    check()
    const timer = setInterval(check, RUNTIME_POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const preflightNotes = preflight
    ? [...preflight.problems, ...(preflight.slowDriveWarning ? [preflight.slowDriveWarning] : [])]
    : []

  const modelRunning = runtime?.running === true
  const indexedCount = docs?.filter((d) => d.status === 'indexed').length ?? null

  const headline = modelRunning
    ? 'Ready to chat.'
    : status?.activeModelId
      ? 'Getting ready…'
      : 'Almost set up.'

  // ---- Readiness rows ----------------------------------------------------------

  const workspaceRow: ReadinessRowProps = {
    icon: '🗄',
    label: 'Workspace',
    value:
      status == null
        ? 'Checking…'
        : status.workspaceMode === 'encrypted'
          ? 'Encrypted — locked with your password when the app is closed'
          : 'Plaintext (developer mode)',
    badge:
      status == null ? null : status.workspaceMode === 'encrypted' ? (
        <Badge tone="success" icon="✓">
          Protected
        </Badge>
      ) : (
        <Badge tone="neutral" icon="○">
          Developer
        </Badge>
      )
  }

  const modelRow: ReadinessRowProps = modelRunning
    ? {
        icon: '🧠',
        label: 'AI model',
        value: `${runtime?.modelId ?? 'Your model'} is running on this device`,
        badge: (
          <Badge tone="success" icon="▶">
            Running
          </Badge>
        )
      }
    : status?.activeModelId
      ? {
          icon: '🧠',
          label: 'AI model',
          value: `${status.activeModelId} is selected — it may still be loading`,
          badge: (
            <Badge tone="neutral" icon="○">
              Starting
            </Badge>
          ),
          action: (
            <Button size="sm" onClick={() => onNavigate('models')}>
              Open AI Model
            </Button>
          )
        }
      : {
          icon: '🧠',
          label: 'AI model',
          value: 'No model selected yet',
          badge: (
            <Badge tone="warning" icon="⚠">
              Needs a model
            </Badge>
          ),
          action: (
            <Button size="sm" onClick={() => onNavigate('models')}>
              Choose a model
            </Button>
          )
        }

  const docsRow: ReadinessRowProps = {
    icon: '📄',
    label: 'Documents',
    value:
      indexedCount == null
        ? 'Checking…'
        : indexedCount === 0
          ? 'No documents yet — add some to ask about them'
          : `${indexedCount} ${indexedCount === 1 ? 'document' : 'documents'} ready to ask about`,
    badge:
      indexedCount == null ? null : indexedCount > 0 ? (
        <Badge tone="success" icon="✓">
          Ready
        </Badge>
      ) : (
        <Badge tone="neutral" icon="○">
          None yet
        </Badge>
      ),
    action:
      indexedCount === 0 ? (
        <Button size="sm" onClick={() => onNavigate('documents')}>
          Add documents
        </Button>
      ) : undefined
  }

  return (
    <div className="screen">
      <h1>{headline}</h1>
      <p className="lead">
        A private, offline AI workspace. Your prompts, documents, and chat history stay on
        this device.
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

      <div className="card readiness-card">
        <ReadinessRow {...workspaceRow} />
        <ReadinessRow {...modelRow} />
        <ReadinessRow {...docsRow} />
      </div>

      <div className="actions">
        <Button variant="primary" onClick={() => onNavigate('chat')}>
          Start chatting
        </Button>
        {indexedCount !== 0 && (
          <Button onClick={() => onNavigate('ask-documents')}>Ask my documents</Button>
        )}
        {indexedCount !== 0 && <Button onClick={() => onNavigate('documents')}>Add documents</Button>}
      </div>
    </div>
  )
}

interface ReadinessRowProps {
  icon: string
  label: string
  value: string
  badge?: JSX.Element | null
  action?: JSX.Element
}

function ReadinessRow({ icon, label, value, badge, action }: ReadinessRowProps): JSX.Element {
  return (
    <div className="readiness-row">
      <span className="readiness-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="readiness-text">
        <div className="readiness-label">{label}</div>
        <div className="readiness-value">{value}</div>
      </div>
      {badge}
      {action != null && <div className="readiness-action">{action}</div>}
    </div>
  )
}
