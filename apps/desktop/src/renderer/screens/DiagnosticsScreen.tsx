import { useEffect, useState } from 'react'
import type { DriveStatus } from '@shared/types'

export function DiagnosticsScreen(): JSX.Element {
  const [drive, setDrive] = useState<DriveStatus | null>(null)

  useEffect(() => {
    window.api?.getDriveStatus().then(setDrive).catch(() => setDrive(null))
  }, [])

  return (
    <div className="screen">
      <h1>Diagnostics</h1>
      <p className="lead">Local-only diagnostics. Nothing here is ever uploaded.</p>

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
