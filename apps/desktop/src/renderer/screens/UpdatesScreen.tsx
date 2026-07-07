import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Banner, Button, Progress } from '../components'
import { useT } from '../i18n'
import type { UpdaterStatus, UpdateState } from '@shared/types'

// Updates (a bottom utility, parallel to Settings): a thin surface over the loader launcher's
// localhost control API — check for a staged delta, watch it download, and install (which
// relaunches). When the launcher is absent (dev / not booted from the drive) the main process
// serves a MOCK and reports `mock: true`; we show a warning so nobody mistakes it for real.

const BUSY: UpdateState[] = ['checking', 'downloading', 'applying']
// Poll fast enough for a smooth progress bar while busy; idle just needs the occasional refresh.
const POLL_BUSY_MS = 600
const POLL_IDLE_MS = 3000

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0)

export function UpdatesScreen(): JSX.Element {
  const { t } = useT()
  const [info, setInfo] = useState<UpdaterStatus | null>(null)
  const [acting, setActing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Self-rescheduling poll: cadence follows the state (fast while busy) so the bar animates
  // without hammering the API when idle. Reschedules itself; cleared on unmount.
  const poll = useCallback(async () => {
    try {
      const next = await window.api.getUpdateStatus()
      setInfo(next)
      const delay = BUSY.includes(next.status.state) ? POLL_BUSY_MS : POLL_IDLE_MS
      timer.current = setTimeout(() => void poll(), delay)
    } catch {
      timer.current = setTimeout(() => void poll(), POLL_IDLE_MS)
    }
  }, [])

  useEffect(() => {
    void poll()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [poll])

  const status = info?.status
  const state = status?.state ?? 'idle'
  const busy = BUSY.includes(state)

  const onCheck = async (): Promise<void> => {
    setActing(true)
    try {
      await window.api.checkForUpdate()
      await poll() // pick up the state change immediately (poll reschedules itself)
    } finally {
      setActing(false)
    }
  }

  const onInstall = async (): Promise<void> => {
    setActing(true)
    try {
      await window.api.applyUpdate()
      await poll()
    } finally {
      setActing(false)
    }
  }

  // One-line status summary + the tone of the small state badge.
  const stateLabel: Record<UpdateState, string> = {
    idle: t('updates.state.idle'),
    checking: t('updates.state.checking'),
    downloading: t('updates.state.downloading'),
    ready: t('updates.state.ready'),
    applying: t('updates.state.applying'),
    failed: t('updates.state.failed')
  }
  const badgeTone = state === 'failed' ? 'error' : state === 'ready' ? 'success' : 'neutral'

  const progressLabel =
    state === 'downloading'
      ? t('updates.downloadLabel', {
          done: status?.done ?? 0,
          total: status?.total ?? 0,
          doneMb: mb(status?.done_bytes ?? 0),
          totalMb: mb(status?.total_bytes ?? 0),
          rate: `${mb(status?.rate_bps ?? 0)} MB/s`
        })
      : t('updates.installLabel', {
          done: status?.done ?? 0,
          total: status?.total ?? 0,
          doneMb: mb(status?.done_bytes ?? 0),
          totalMb: mb(status?.total_bytes ?? 0)
        })

  return (
    <div className="screen">
      <h1>{t('updates.title')}</h1>
      <p className="lead">{t('updates.subtitle')}</p>

      {info?.mock && (
        <Banner tone="warning" t={t}>
          {t('updates.mockWarning')}
        </Banner>
      )}

      {state === 'failed' && (
        <Banner tone="error" t={t}>
          {t('updates.failedBanner', { message: status?.message ?? '' })}
        </Banner>
      )}

      <div className="card">
        <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge tone={badgeTone}>{stateLabel[state]}</Badge>
          {status?.version ? (
            <span className="hint">
              {t('updates.version', { version: status.version })}
            </span>
          ) : null}
        </div>

        {status?.message && state !== 'failed' && <p className="hint">{status.message}</p>}

        {state === 'ready' && (
          <Banner tone="success" t={t}>
            {t('updates.readyBanner', { version: status?.version ?? '' })}
          </Banner>
        )}

        {(state === 'downloading' || state === 'applying') && (
          <Progress
            label={progressLabel}
            value={status?.done_bytes}
            max={status?.total_bytes}
          />
        )}

        <div className="actions" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Button onClick={() => void onCheck()} disabled={busy || acting}>
            {state === 'checking' ? t('updates.checking') : t('updates.check')}
          </Button>
          {state === 'ready' && (
            <Button variant="primary" onClick={() => void onInstall()} disabled={acting}>
              {t('updates.install')}
            </Button>
          )}
        </div>

        {state === 'ready' && <p className="hint">{t('updates.applyNote')}</p>}
      </div>
    </div>
  )
}
