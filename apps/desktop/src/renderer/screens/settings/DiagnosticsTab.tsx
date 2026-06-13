import { useCallback, useEffect, useState } from 'react'
import { Banner, Button, useToast } from '../../components'
import { useT, type I18n } from '../../i18n'
import { localizeServerCopy } from '../../lib/displayMap'
import type { MessageKey, UiLanguage } from '@shared/i18n'
import type {
  AppSettings,
  AppStatus,
  AuditEvent,
  AuditEventType,
  BenchmarkResult,
  DriveStatus,
  RuntimeInstallInfo,
  RuntimeStatus
} from '@shared/types'

// "Diagnostics (advanced)" tab of the Settings screen. The home of every technical
// detail: the Activity panel, the log tail, the Acceleration line + "Try GPU again",
// and the hardware benchmark. Visually quieter than a destination screen — it is a
// support surface, not an everyday one (guidelines §2).

/** How many activity entries each page load fetches. */
const ACTIVITY_PAGE_SIZE = 50

/** Friendly labels for the Activity panel's entries + type filter (spec §11.4 tone).
 *  Label values are MessageKeys resolved at render (i18n-plan §5). */
const AUDIT_TYPE_LABELS: Record<AuditEventType, MessageKey> = {
  runtime_started: 'diag.audit.runtime_started',
  runtime_stopped: 'diag.audit.runtime_stopped',
  runtime_crashed: 'diag.audit.runtime_crashed',
  runtime_fallback: 'diag.audit.runtime_fallback',
  model_selected: 'diag.audit.model_selected',
  model_verified: 'diag.audit.model_verified',
  model_download_started: 'diag.audit.model_download_started',
  model_download_verified: 'diag.audit.model_download_verified',
  model_download_failed: 'diag.audit.model_download_failed',
  document_imported: 'diag.audit.document_imported',
  document_reindexed: 'diag.audit.document_reindexed',
  document_deleted: 'diag.audit.document_deleted',
  document_task_completed: 'diag.audit.document_task_completed',
  document_task_failed: 'diag.audit.document_task_failed',
  document_exported: 'diag.audit.document_exported',
  conversation_deleted: 'diag.audit.conversation_deleted',
  conversation_exported: 'diag.audit.conversation_exported',
  workspace_created: 'diag.audit.workspace_created',
  workspace_unlocked: 'diag.audit.workspace_unlocked',
  workspace_locked: 'diag.audit.workspace_locked',
  workspace_unlock_failed: 'diag.audit.workspace_unlock_failed',
  workspace_password_changed: 'diag.audit.workspace_password_changed',
  settings_changed: 'diag.audit.settings_changed',
  policy_warning: 'diag.audit.policy_warning',
  offline_guard_violation: 'diag.audit.offline_guard_violation'
}

function auditLabel(type: AuditEventType, t: I18n['t']): string {
  const key = AUDIT_TYPE_LABELS[type]
  return key != null ? t(key) : type
}

/**
 * The "Acceleration" line (architecture.md GPU record §8): the live backend when a
 * model is running, else what the cached probe says this machine offers. Friendly
 * tone — CPU is presented as normal, never degraded.
 */
function accelerationLabel(
  runtime: RuntimeStatus | null,
  settings: AppSettings | null,
  t: I18n['t']
): string {
  if (runtime?.running && runtime.backend) {
    if (runtime.backend === 'gpu')
      return t('diag.accel.gpu', { name: runtime.gpuName ?? t('diag.accel.gpuFallbackName') })
    if (runtime.backend === 'mock') return t('diag.accel.mock')
    return t('diag.accel.cpu')
  }
  const probed = settings?.gpuProbe?.devices ?? []
  if (probed.length > 0) return t('diag.accel.gpuAvailable', { name: probed[0].name })
  return t('diag.accel.cpu')
}

/** Locale-aware one-decimal number (file sizes / RAM) — grouping off so EN output
 *  stays byte-identical to the previous toFixed(1). */
function fmt1(n: number, lang: UiLanguage): string {
  return n.toLocaleString(lang, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false
  })
}

export function DiagnosticsTab(): JSX.Element {
  const { t, lang } = useT()
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [bench, setBench] = useState<BenchmarkResult | null>(null)
  const [app, setApp] = useState<AppStatus | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [install, setInstall] = useState<RuntimeInstallInfo | null>(null)
  const [logTail, setLogTail] = useState<string[] | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Activity panel: loaded on demand, paged via the beforeId cursor.
  const [showActivity, setShowActivity] = useState(false)
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [moreAvailable, setMoreAvailable] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  // "Saved" confirmations are transient toasts (guidelines §6).
  const toast = useToast()

  const refreshStatus = useCallback(async (): Promise<void> => {
    window.api?.getAppStatus().then(setApp).catch(() => setApp(null))
    window.api?.getRuntimeStatus().then(setRuntime).catch(() => setRuntime(null))
    window.api?.getSettings().then(setSettings).catch(() => setSettings(null))
  }, [])

  const refreshLogs = useCallback(async (): Promise<void> => {
    window.api?.getLogTail().then(setLogTail).catch(() => setLogTail([]))
  }, [])

  const loadActivity = useCallback(async (): Promise<void> => {
    try {
      const page = (await window.api?.getAuditEvents(ACTIVITY_PAGE_SIZE)) ?? []
      setEvents(page)
      setMoreAvailable(page.length === ACTIVITY_PAGE_SIZE)
    } catch {
      setEvents([])
      setMoreAvailable(false)
    }
  }, [])

  const loadMoreActivity = useCallback(async (): Promise<void> => {
    const last = events?.[events.length - 1]
    if (!last) return
    try {
      const page = (await window.api?.getAuditEvents(ACTIVITY_PAGE_SIZE, last.id)) ?? []
      setEvents((prev) => [...(prev ?? []), ...page])
      setMoreAvailable(page.length === ACTIVITY_PAGE_SIZE)
    } catch {
      setMoreAvailable(false)
    }
  }, [events])

  async function exportActivity(): Promise<void> {
    try {
      const path = await window.api.exportAuditLog()
      if (path) toast(t('diag.activity.savedTo', { path }))
    } catch {
      // Export is cancellable from the OS dialog; a failure simply shows no toast.
    }
  }

  useEffect(() => {
    window.api?.getDriveStatus().then(setDrive).catch(() => setDrive(null))
    window.api?.getRuntimeInstall().then(setInstall).catch(() => setInstall(null))
    // Show the last benchmark, if one has been run before, so the profile persists across launches.
    window.api
      ?.getSettings()
      .then((s) => setBench(s.lastBenchmark))
      .catch(() => setBench(null))
    void refreshStatus()
  }, [refreshStatus])

  // "Try GPU again" (architecture.md GPU record §8): clears the automatic compatibility-mode flag
  // (e.g. after a graphics-driver update) WITHOUT touching the Settings toggle. The
  // dedicated IPC also invalidates the session probe cache + re-probes — a plain
  // settings write would keep a stale "no GPU" probe for the whole session.
  async function tryGpuAgain(): Promise<void> {
    const next = await window.api.tryGpuAgain()
    setSettings(next)
  }

  async function runBenchmark(): Promise<void> {
    setRunning(true)
    setError(null)
    try {
      const result = await window.api.runBenchmark()
      setBench(result)
      // The benchmark re-probes + persists the GPU info — refresh so the
      // Acceleration line reflects it without a manual "Refresh".
      void refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <p className="hint">{t('diag.localOnly')}</p>

      <div className="card">
        <h2>{t('diag.app.title')}</h2>
        <dl className="kv">
          <dt>{t('diag.app.version')}</dt>
          <dd>{app ? `${app.appName} ${app.appVersion}` : t('diag.app.unknown')}</dd>
          <dt>{t('diag.app.selectedModel')}</dt>
          <dd>{app?.activeModelId ?? t('diag.app.noneSelected')}</dd>
          <dt>{t('diag.app.profile')}</dt>
          <dd>{app?.hardwareProfile ?? 'UNKNOWN'}</dd>
          <dt>{t('diag.app.runtime')}</dt>
          <dd>
            {runtime
              ? runtime.running
                ? t('diag.app.runtimeRunning', {
                    model: runtime.modelId ?? t('diag.app.unknownModel'),
                    onPort: runtime.port != null ? t('diag.app.onPort', { port: runtime.port }) : '',
                    health: runtime.healthy ? t('diag.app.healthy') : t('diag.app.unhealthy')
                  })
                : t('diag.app.stopped')
              : t('diag.app.unknown')}
          </dd>
          <dt>{t('diag.app.acceleration')}</dt>
          <dd>{accelerationLabel(runtime, settings, t)}</dd>
          <dt>{t('diag.app.runtimeBuild')}</dt>
          <dd>
            {install
              ? `llama.cpp ${install.version} (${install.backend})`
              : t('diag.app.noInstallMarker')}
          </dd>
        </dl>
        {settings?.gpuAutoDisabled && (
          <Banner
            tone="info"
            action={
              settings.gpuMode === 'auto' ? (
                <Button size="sm" onClick={() => void tryGpuAgain()}>
                  {t('diag.gpu.tryAgain')}
                </Button>
              ) : undefined
            }
          >
            {t('diag.gpu.compat')}{' '}
            {settings.gpuMode === 'auto' ? t('diag.gpu.tryHint') : t('diag.gpu.offHint')}
          </Banner>
        )}
        <Button size="sm" onClick={() => void refreshStatus()}>
          {t('diag.refresh')}
        </Button>
      </div>

      <div className="card">
        <h2>{t('diag.bench.title')}</h2>
        <p className="hint">{t('diag.bench.hint')}</p>
        <Button variant="primary" onClick={() => void runBenchmark()} disabled={running}>
          {running ? t('diag.bench.running') : bench ? t('diag.bench.rerun') : t('diag.bench.run')}
        </Button>
        {error && <Banner tone="error">{t('diag.bench.failed', { error })}</Banner>}

        {bench && (
          <>
            <dl className="kv">
              <dt>{t('diag.bench.profile')}</dt>
              <dd>
                <strong>{bench.profile}</strong>
              </dd>
              <dt>{t('diag.bench.recommended')}</dt>
              <dd>{bench.recommendedModelId ?? t('diag.bench.noMatch')}</dd>
              <dt>{t('diag.bench.ram')}</dt>
              <dd>{bench.ramGb > 0 ? `${fmt1(bench.ramGb, lang)} GB` : t('diag.app.unknown')}</dd>
              <dt>{t('diag.bench.cpu')}</dt>
              <dd>
                {bench.cpuModel || t('diag.app.unknown')}
                {bench.cpuCores > 0 ? t('diag.bench.cores', { count: bench.cpuCores }) : ''}
              </dd>
              <dt>{t('diag.bench.osArch')}</dt>
              <dd>
                {bench.os || t('diag.app.unknown')} ({bench.arch || t('diag.app.unknown')})
              </dd>
              <dt>{t('diag.bench.gpu')}</dt>
              <dd>{bench.gpu ?? t('diag.bench.notDetected')}</dd>
              <dt>{t('diag.bench.driveRead')}</dt>
              <dd>
                {bench.driveReadMbps != null
                  ? `${bench.driveReadMbps} MB/s`
                  : t('diag.bench.notMeasured')}
              </dd>
              <dt>{t('diag.bench.driveWrite')}</dt>
              <dd>
                {bench.driveWriteMbps != null
                  ? `${bench.driveWriteMbps} MB/s`
                  : t('diag.bench.notMeasured')}
              </dd>
              <dt>{t('diag.bench.tokens')}</dt>
              <dd>
                {bench.tokensPerSecond != null
                  ? `${bench.tokensPerSecond}`
                  : t('diag.bench.tokensNotMeasured')}
              </dd>
              <dt>{t('diag.bench.lastRun')}</dt>
              <dd>{new Date(bench.ranAt).toLocaleString(lang)}</dd>
            </dl>

            {bench.warnings.length > 0 && (
              <ul className="benchmark-warnings">
                {/* Warnings are persisted canonical English inside lastBenchmark —
                    the D-L4 display map translates the known set at render. */}
                {bench.warnings.map((w, i) => (
                  <li key={i} className="hint">
                    {localizeServerCopy(t, w)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.system.title')}</h2>
        {drive ? (
          <dl className="kv">
            <dt>{t('diag.system.osPlatform')}</dt>
            <dd>{drive.platform} ({drive.arch})</dd>
            <dt>{t('diag.system.freeSpace')}</dt>
            <dd>
              {drive.freeBytes != null
                ? `${fmt1(drive.freeBytes / 1e9, lang)} GB`
                : t('diag.app.unknown')}
            </dd>
          </dl>
        ) : (
          <p className="hint">{t('diag.system.loadFailed')}</p>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.paths.title')}</h2>
        {drive ? (
          <dl className="kv">
            <dt>{t('privacy.data.driveRoot')}</dt>
            <dd>{drive.rootPath}</dd>
            <dt>{t('privacy.data.workspace')}</dt>
            <dd>{drive.workspacePath}</dd>
            <dt>{t('privacy.data.models')}</dt>
            <dd>{drive.modelsPath}</dd>
            <dt>{t('privacy.data.logs')}</dt>
            <dd>{drive.logsPath}</dd>
            <dt>{t('diag.paths.prepared')}</dt>
            <dd>{drive.isPreparedDrive ? t('diag.paths.yes') : t('diag.paths.noFallback')}</dd>
            <dt>{t('diag.paths.writable')}</dt>
            <dd>{drive.writable ? t('diag.paths.yes') : t('diag.paths.no')}</dd>
          </dl>
        ) : (
          <p className="hint">{t('diag.paths.loadFailed')}</p>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.activity.title')}</h2>
        <p className="hint">{t('diag.activity.hint')}</p>
        <div className="actions">
          <Button
            size="sm"
            onClick={() => {
              setShowActivity((v) => !v)
              if (!showActivity) void loadActivity()
            }}
          >
            {showActivity ? t('diag.activity.hide') : t('diag.activity.show')}
          </Button>
          {showActivity && (
            <>
              <Button size="sm" onClick={() => void loadActivity()}>
                {t('diag.refresh')}
              </Button>
              <Button size="sm" onClick={() => void exportActivity()}>
                {t('diag.activity.export')}
              </Button>
            </>
          )}
        </div>
        {showActivity && (
          <>
            {events != null && events.length > 0 && (
              <label className="hint" style={{ display: 'block', marginTop: 8 }}>
                {t('diag.activity.filterShow')}{' '}
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="all">{t('diag.activity.filterAll')}</option>
                  {[...new Set(events.map((ev) => ev.type))].map((type) => (
                    <option key={type} value={type}>
                      {auditLabel(type, t)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {events == null ? (
              <p className="hint">{t('diag.activity.loading')}</p>
            ) : events.length === 0 ? (
              <p className="hint">{t('diag.activity.empty')}</p>
            ) : (
              <ul className="activity-list">
                {events
                  .filter((ev) => typeFilter === 'all' || ev.type === typeFilter)
                  .map((ev) => (
                    <li key={ev.id} className="hint">
                      <span className="activity-time">
                        {new Date(ev.createdAt).toLocaleString(lang)}
                      </span>{' '}
                      — <strong>{auditLabel(ev.type, t)}</strong>: {ev.message}
                    </li>
                  ))}
              </ul>
            )}
            {moreAvailable && (
              <Button size="sm" onClick={() => void loadMoreActivity()}>
                {t('diag.activity.earlier')}
              </Button>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.logs.title')}</h2>
        <p className="hint">
          {t('diag.logs.hintBefore')}
          <code>logs/app.log</code>
          {t('diag.logs.hintAfter')}
        </p>
        <div className="actions">
          <Button
            size="sm"
            onClick={() => {
              setShowLogs((v) => !v)
              if (!showLogs) void refreshLogs()
            }}
          >
            {showLogs ? t('diag.logs.hide') : t('diag.logs.show')}
          </Button>
          {showLogs && (
            <Button size="sm" onClick={() => void refreshLogs()}>
              {t('diag.refresh')}
            </Button>
          )}
        </div>
        {showLogs && (
          <pre className="log-tail">
            {logTail == null
              ? t('diag.activity.loading')
              : logTail.length === 0
                ? t('diag.logs.empty')
                : logTail.join('\n')}
          </pre>
        )}
      </div>
    </>
  )
}
