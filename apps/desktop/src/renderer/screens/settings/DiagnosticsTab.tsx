import { useCallback, useEffect, useState } from 'react'
import { Banner, Button, useToast } from '../../components'
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

// "Diagnostics (advanced)" tab of the Settings screen (Phase 26 — the former
// DiagnosticsScreen). Still the home of every technical detail: the Activity panel
// (Phase 19), the log tail, the Acceleration line + "Try GPU again" (Phase 16), and
// the hardware benchmark. Visually quieter than a destination screen — it is a
// support surface, not an everyday one (guidelines §2).

/** How many activity entries each page load fetches. */
const ACTIVITY_PAGE_SIZE = 50

/** Friendly labels for the Activity panel's entries + type filter (§11.4 tone). */
const AUDIT_TYPE_LABELS: Record<AuditEventType, string> = {
  runtime_started: 'Model started',
  runtime_stopped: 'Model stopped',
  runtime_crashed: 'Model stopped unexpectedly',
  runtime_fallback: 'Compatibility mode',
  model_selected: 'Model selected',
  model_verified: 'Model checksum checked',
  model_download_started: 'Download started',
  model_download_verified: 'Download verified',
  model_download_failed: 'Download failed',
  document_imported: 'Document imported',
  document_reindexed: 'Document re-indexed',
  document_deleted: 'Document deleted',
  document_task_completed: 'Document task finished',
  document_task_failed: 'Document task failed',
  document_exported: 'Document exported',
  conversation_deleted: 'Conversation deleted',
  conversation_exported: 'Conversation exported',
  workspace_created: 'Workspace created',
  workspace_unlocked: 'Workspace unlocked',
  workspace_locked: 'Workspace locked',
  workspace_unlock_failed: 'Unlock attempt failed',
  workspace_password_changed: 'Workspace password changed',
  settings_changed: 'Settings changed',
  policy_warning: 'Policy notice',
  offline_guard_violation: 'Network attempt noticed'
}

function auditLabel(type: AuditEventType): string {
  return AUDIT_TYPE_LABELS[type] ?? type
}

/**
 * The "Acceleration" line (Phase 16, architecture.md GPU record §8): the live backend when a
 * model is running, else what the cached probe says this machine offers. §11.4 tone —
 * CPU is presented as normal, never degraded.
 */
function accelerationLabel(runtime: RuntimeStatus | null, settings: AppSettings | null): string {
  if (runtime?.running && runtime.backend) {
    if (runtime.backend === 'gpu') return `${runtime.gpuName ?? 'Graphics card'} (GPU)`
    if (runtime.backend === 'mock') return 'Built-in demo runtime'
    return 'CPU'
  }
  const probed = settings?.gpuProbe?.devices ?? []
  if (probed.length > 0) return `${probed[0].name} (GPU available)`
  return 'CPU'
}

export function DiagnosticsTab(): JSX.Element {
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
  // Activity panel (Phase 19): loaded on demand, paged via the beforeId cursor.
  const [showActivity, setShowActivity] = useState(false)
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [moreAvailable, setMoreAvailable] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  // "Saved" confirmations are transient toasts (Phase 24, guidelines §6).
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
      if (path) toast(`Activity log saved to ${path}`)
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
  // dedicated IPC also invalidates the session probe cache + re-probes (audit fix —
  // a plain settings write would keep a stale "no GPU" probe for the whole session).
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
      <p className="hint">Local-only diagnostics. Nothing here is ever uploaded.</p>

      <div className="card">
        <h2>App &amp; runtime</h2>
        <dl className="kv">
          <dt>App version</dt>
          <dd>{app ? `${app.appName} ${app.appVersion}` : 'unknown'}</dd>
          <dt>Selected model</dt>
          <dd>{app?.activeModelId ?? 'none selected'}</dd>
          <dt>Hardware profile</dt>
          <dd>{app?.hardwareProfile ?? 'UNKNOWN'}</dd>
          <dt>Runtime</dt>
          <dd>
            {runtime
              ? runtime.running
                ? `Running — ${runtime.modelId ?? 'unknown model'}${
                    runtime.port != null ? ` on 127.0.0.1:${runtime.port}` : ''
                  } (${runtime.healthy ? 'healthy' : 'unhealthy'})`
              : 'Stopped'
              : 'unknown'}
          </dd>
          <dt>Acceleration</dt>
          <dd>{accelerationLabel(runtime, settings)}</dd>
          <dt>Runtime build</dt>
          <dd>
            {install
              ? `llama.cpp ${install.version} (${install.backend})`
              : 'no install marker (manually provisioned drive)'}
          </dd>
        </dl>
        {settings?.gpuAutoDisabled && (
          <Banner
            tone="info"
            action={
              settings.gpuMode === 'auto' ? (
                <Button size="sm" onClick={() => void tryGpuAgain()}>
                  Try GPU again
                </Button>
              ) : undefined
            }
          >
            Running in compatibility mode: responses use the CPU, which works on every
            machine.{' '}
            {settings.gpuMode === 'auto'
              ? 'If you have updated your graphics driver, you can try the graphics card again.'
              : 'GPU acceleration is turned off in Settings — turn it back on there to use the graphics card again.'}
          </Banner>
        )}
        <Button size="sm" onClick={() => void refreshStatus()}>
          Refresh
        </Button>
      </div>

      <div className="card">
        <h2>Hardware benchmark</h2>
        <p className="hint">
          Measures RAM, CPU, and drive speed on this device to recommend a model. Runs entirely
          offline — no data leaves your machine.
        </p>
        <Button variant="primary" onClick={() => void runBenchmark()} disabled={running}>
          {running ? 'Running…' : bench ? 'Re-run benchmark' : 'Run benchmark'}
        </Button>
        {error && <Banner tone="error">Benchmark failed: {error}</Banner>}

        {bench && (
          <>
            <dl className="kv">
              <dt>Assigned profile</dt>
              <dd>
                <strong>{bench.profile}</strong>
              </dd>
              <dt>Recommended model</dt>
              <dd>{bench.recommendedModelId ?? 'No matching model'}</dd>
              <dt>RAM</dt>
              <dd>{bench.ramGb > 0 ? `${bench.ramGb.toFixed(1)} GB` : 'unknown'}</dd>
              <dt>CPU</dt>
              <dd>
                {bench.cpuModel || 'unknown'}
                {bench.cpuCores > 0 ? ` (${bench.cpuCores} cores)` : ''}
              </dd>
              <dt>OS / arch</dt>
              <dd>
                {bench.os || 'unknown'} ({bench.arch || 'unknown'})
              </dd>
              <dt>GPU</dt>
              <dd>{bench.gpu ?? 'not detected'}</dd>
              <dt>Drive read</dt>
              <dd>{bench.driveReadMbps != null ? `${bench.driveReadMbps} MB/s` : 'not measured'}</dd>
              <dt>Drive write</dt>
              <dd>{bench.driveWriteMbps != null ? `${bench.driveWriteMbps} MB/s` : 'not measured'}</dd>
              <dt>Tokens / sec</dt>
              <dd>
                {bench.tokensPerSecond != null
                  ? `${bench.tokensPerSecond}`
                  : 'not measured (start a model first)'}
              </dd>
              <dt>Last run</dt>
              <dd>{new Date(bench.ranAt).toLocaleString()}</dd>
            </dl>

            {bench.warnings.length > 0 && (
              <ul className="benchmark-warnings">
                {bench.warnings.map((w, i) => (
                  <li key={i} className="hint">
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>System</h2>
        {drive ? (
          <dl className="kv">
            <dt>OS / platform</dt>
            <dd>{drive.platform} ({drive.arch})</dd>
            <dt>Free space</dt>
            <dd>{drive.freeBytes != null ? `${(drive.freeBytes / 1e9).toFixed(1)} GB` : 'unknown'}</dd>
          </dl>
        ) : (
          <p className="hint">System detection lands in Phase 1.</p>
        )}
      </div>

      <div className="card">
        <h2>Paths</h2>
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
            <dt>Prepared drive</dt>
            <dd>{drive.isPreparedDrive ? 'Yes' : 'No (app-data fallback)'}</dd>
            <dt>Writable</dt>
            <dd>{drive.writable ? 'Yes' : 'No'}</dd>
          </dl>
        ) : (
          <p className="hint">Drive/workspace detection lands in Phase 1.</p>
        )}
      </div>

      <div className="card">
        <h2>Activity</h2>
        <p className="hint">
          A local record of what the app did — model starts, downloads, document imports,
          workspace events. It stays in your workspace (encrypted when the workspace is)
          and is never uploaded. It never contains chat text or document contents.
        </p>
        <div className="actions">
          <Button
            size="sm"
            onClick={() => {
              setShowActivity((v) => !v)
              if (!showActivity) void loadActivity()
            }}
          >
            {showActivity ? 'Hide activity' : 'Show activity'}
          </Button>
          {showActivity && (
            <>
              <Button size="sm" onClick={() => void loadActivity()}>
                Refresh
              </Button>
              <Button size="sm" onClick={() => void exportActivity()}>
                Export to file…
              </Button>
            </>
          )}
        </div>
        {showActivity && (
          <>
            {events != null && events.length > 0 && (
              <label className="hint" style={{ display: 'block', marginTop: 8 }}>
                Show{' '}
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="all">All activity</option>
                  {[...new Set(events.map((ev) => ev.type))].map((t) => (
                    <option key={t} value={t}>
                      {auditLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {events == null ? (
              <p className="hint">Loading…</p>
            ) : events.length === 0 ? (
              <p className="hint">Nothing recorded yet — activity appears here as you use the app.</p>
            ) : (
              <ul className="activity-list">
                {events
                  .filter((ev) => typeFilter === 'all' || ev.type === typeFilter)
                  .map((ev) => (
                    <li key={ev.id} className="hint">
                      <span className="activity-time">
                        {new Date(ev.createdAt).toLocaleString()}
                      </span>{' '}
                      — <strong>{auditLabel(ev.type)}</strong>: {ev.message}
                    </li>
                  ))}
              </ul>
            )}
            {moreAvailable && (
              <Button size="sm" onClick={() => void loadMoreActivity()}>
                Show earlier activity
              </Button>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Recent logs</h2>
        <p className="hint">
          The tail of <code>logs/app.log</code> on this device. Logs are local-only and never
          uploaded; they contain no document contents or chat text.
        </p>
        <div className="actions">
          <Button
            size="sm"
            onClick={() => {
              setShowLogs((v) => !v)
              if (!showLogs) void refreshLogs()
            }}
          >
            {showLogs ? 'Hide logs' : 'Show logs'}
          </Button>
          {showLogs && (
            <Button size="sm" onClick={() => void refreshLogs()}>
              Refresh
            </Button>
          )}
        </div>
        {showLogs && (
          <pre className="log-tail">
            {logTail == null ? 'Loading…' : logTail.length === 0 ? '(log is empty)' : logTail.join('\n')}
          </pre>
        )}
      </div>
    </>
  )
}
