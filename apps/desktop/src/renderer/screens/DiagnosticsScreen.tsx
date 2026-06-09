import { useEffect, useState } from 'react'
import type { BenchmarkResult, DriveStatus } from '@shared/types'

export function DiagnosticsScreen(): JSX.Element {
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [bench, setBench] = useState<BenchmarkResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api?.getDriveStatus().then(setDrive).catch(() => setDrive(null))
    // Show the last benchmark, if one has been run before, so the profile persists across launches.
    window.api
      ?.getSettings()
      .then((s) => setBench(s.lastBenchmark))
      .catch(() => setBench(null))
  }, [])

  async function runBenchmark(): Promise<void> {
    setRunning(true)
    setError(null)
    try {
      const result = await window.api.runBenchmark()
      setBench(result)
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
    </div>
  )
}
