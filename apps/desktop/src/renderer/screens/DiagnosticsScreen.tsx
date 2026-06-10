import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  AppStatus,
  BenchmarkResult,
  DriveStatus,
  RuntimeInstallInfo,
  RuntimeStatus
} from '@shared/types'

/**
 * The "Acceleration" line (Phase 16, gpu-support-plan §8): the live backend when a
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

export function DiagnosticsScreen(): JSX.Element {
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

  const refreshStatus = useCallback(async (): Promise<void> => {
    window.api?.getAppStatus().then(setApp).catch(() => setApp(null))
    window.api?.getRuntimeStatus().then(setRuntime).catch(() => setRuntime(null))
    window.api?.getSettings().then(setSettings).catch(() => setSettings(null))
  }, [])

  const refreshLogs = useCallback(async (): Promise<void> => {
    window.api?.getLogTail().then(setLogTail).catch(() => setLogTail([]))
  }, [])

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

  // "Try GPU again" (gpu-support-plan §8): clears the automatic compatibility-mode flag
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
    <div className="screen">
      <h1>Diagnostics</h1>
      <p className="lead">Local-only diagnostics. Nothing here is ever uploaded.</p>

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
          <div className="hint" style={{ marginTop: 8 }}>
            <p className="hint">
              Running in compatibility mode: responses use the CPU, which works on every
              machine.{' '}
              {settings.gpuMode === 'auto'
                ? 'If you have updated your graphics driver, you can try the graphics card again.'
                : 'GPU acceleration is turned off in Settings — turn it back on there to use the graphics card again.'}
            </p>
            {settings.gpuMode === 'auto' && (
              <button className="btn sm" onClick={() => void tryGpuAgain()}>
                Try GPU again
              </button>
            )}
          </div>
        )}
        <button className="btn sm" onClick={() => void refreshStatus()}>
          Refresh
        </button>
      </div>

      <div className="card">
        <h2>Hardware benchmark</h2>
        <p className="hint">
          Measures RAM, CPU, and drive speed on this device to recommend a model. Runs entirely
          offline — no data leaves your machine.
        </p>
        <button className="btn primary" onClick={runBenchmark} disabled={running}>
          {running ? 'Running…' : bench ? 'Re-run benchmark' : 'Run benchmark'}
        </button>
        {error && <p className="hint error">Benchmark failed: {error}</p>}

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
        <h2>Recent logs</h2>
        <p className="hint">
          The tail of <code>logs/app.log</code> on this device. Logs are local-only and never
          uploaded; they contain no document contents or chat text.
        </p>
        <div className="actions">
          <button
            className="btn sm"
            onClick={() => {
              setShowLogs((v) => !v)
              if (!showLogs) void refreshLogs()
            }}
          >
            {showLogs ? 'Hide logs' : 'Show logs'}
          </button>
          {showLogs && (
            <button className="btn sm" onClick={() => void refreshLogs()}>
              Refresh
            </button>
          )}
        </div>
        {showLogs && (
          <pre className="log-tail">
            {logTail == null ? 'Loading…' : logTail.length === 0 ? '(log is empty)' : logTail.join('\n')}
          </pre>
        )}
      </div>
    </div>
  )
}
