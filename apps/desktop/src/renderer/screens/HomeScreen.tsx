import { useEffect, useState } from 'react'
import { Badge, Banner, Button } from '../components'
import { RUNTIME_POLL_MS } from '../lib/polling'
import { useT } from '../i18n'
import type { AppStatus, DocumentInfo, PreflightResult, RuntimeStatus } from '@shared/types'

interface Props {
  onNavigate: (screen: string) => void
}

// Home as a readiness hub (guidelines §2): answers "is everything ready?"
// at a glance — workspace state, model running?, document count — with ONE primary
// action ("Start chatting") and quiet preflight warnings. Reuses existing IPC only
// (getAppStatus / getRuntimeStatus / listDocuments / runPreflight).

export function HomeScreen({ onNavigate }: Props): JSX.Element {
  const { t, tCount } = useT()
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
    ? t('home.headline.ready')
    : status?.activeModelId
      ? t('home.headline.starting')
      : t('home.headline.almost')

  // ---- Readiness rows ----------------------------------------------------------

  const workspaceRow: ReadinessRowProps = {
    icon: '🗄',
    label: t('home.workspace.label'),
    value:
      status == null
        ? t('home.checking')
        : status.workspaceMode === 'encrypted'
          ? t('home.workspace.encrypted')
          : t('home.workspace.plaintext'),
    badge:
      status == null ? null : status.workspaceMode === 'encrypted' ? (
        <Badge tone="success" icon="✓">
          {t('home.workspace.badgeProtected')}
        </Badge>
      ) : (
        <Badge tone="neutral" icon="○">
          {t('home.workspace.badgeDeveloper')}
        </Badge>
      )
  }

  const modelRow: ReadinessRowProps = modelRunning
    ? {
        icon: '🧠',
        label: t('home.model.label'),
        value: t('home.model.running', {
          model: runtime?.modelId ?? t('home.model.fallbackName')
        }),
        badge: (
          <Badge tone="success" icon="▶">
            {t('home.model.badgeRunning')}
          </Badge>
        )
      }
    : status?.activeModelId
      ? {
          icon: '🧠',
          label: t('home.model.label'),
          value: t('home.model.selected', { model: status.activeModelId }),
          badge: (
            <Badge tone="neutral" icon="○">
              {t('home.model.badgeStarting')}
            </Badge>
          ),
          action: (
            <Button size="sm" onClick={() => onNavigate('models')}>
              {t('home.model.open')}
            </Button>
          )
        }
      : {
          icon: '🧠',
          label: t('home.model.label'),
          value: t('home.model.none'),
          badge: (
            <Badge tone="warning" icon="⚠">
              {t('home.model.badgeNeedsModel')}
            </Badge>
          ),
          action: (
            <Button size="sm" onClick={() => onNavigate('models')}>
              {t('home.model.choose')}
            </Button>
          )
        }

  const docsRow: ReadinessRowProps = {
    icon: '📄',
    label: t('home.docs.label'),
    value:
      indexedCount == null
        ? t('home.checking')
        : indexedCount === 0
          ? t('home.docs.none')
          : tCount('home.docsReady', indexedCount),
    badge:
      indexedCount == null ? null : indexedCount > 0 ? (
        <Badge tone="success" icon="✓">
          {t('home.docs.badgeReady')}
        </Badge>
      ) : (
        <Badge tone="neutral" icon="○">
          {t('home.docs.badgeNone')}
        </Badge>
      ),
    action:
      indexedCount === 0 ? (
        <Button size="sm" onClick={() => onNavigate('documents')}>
          {t('home.docs.add')}
        </Button>
      ) : undefined
  }

  return (
    <div className="screen">
      <h1>{headline}</h1>
      <p className="lead">{t('home.lead')}</p>

      {preflightNotes.length > 0 && (
        <Banner tone="warning">
          {preflightNotes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
          <p>
            {t('home.preflight.continueBefore')}
            <strong>docs</strong>
            {t('home.preflight.continueAfter')}
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
          {t('home.actions.startChat')}
        </Button>
        {indexedCount !== 0 && (
          <Button onClick={() => onNavigate('ask-documents')}>{t('home.actions.askDocs')}</Button>
        )}
        {indexedCount !== 0 && (
          <Button onClick={() => onNavigate('documents')}>{t('home.docs.add')}</Button>
        )}
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
