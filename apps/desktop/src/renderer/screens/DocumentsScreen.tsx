import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentInfo, IngestionStatus } from '@shared/types'

// Documents screen (spec §7.7 / Milestone 4). Import files or a folder via the OS picker
// (opened in the main process), watch each file move through the ingestion statuses, and
// delete / re-index documents. Import runs async in the backend; this screen polls
// getImportJob + listDocuments while a job is in flight (BUILD_STATE: async-with-polling).

const STATUS_LABEL: Record<IngestionStatus, string> = {
  queued: 'Queued',
  extracting: 'Extracting',
  chunking: 'Chunking',
  embedding: 'Embedding',
  indexed: 'Indexed',
  failed: 'Failed',
  deleted: 'Deleted'
}

const ACTIVE_STATUSES: ReadonlySet<IngestionStatus> = new Set([
  'queued',
  'extracting',
  'chunking',
  'embedding'
])

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DocumentsScreen(): JSX.Element {
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setDocs(await window.api.listDocuments())
  }, [])

  useEffect(() => {
    refresh().catch((e) => setError(String(e)))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  // Poll the job + document list until ingestion settles.
  const watchJob = useCallback(
    (jobId: string): void => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const [job] = await Promise.all([window.api.getImportJob(jobId), refresh()])
          if (job.done) {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setBusy(null)
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          setBusy(null)
          setError(String(e))
        }
      }, 400)
    },
    [refresh]
  )

  async function onImport(mode: 'files' | 'folder'): Promise<void> {
    setError(null)
    try {
      const paths = await window.api.pickDocuments(mode)
      if (paths.length === 0) return
      setBusy('import')
      const job = await window.api.importDocuments(paths)
      await refresh()
      if (job.documentIds.length === 0) {
        setBusy(null)
        setError('No supported documents were found in that selection.')
        return
      }
      watchJob(job.jobId)
    } catch (e) {
      setBusy(null)
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  const anyActive = docs?.some((d) => ACTIVE_STATUSES.has(d.status)) ?? false

  return (
    <div className="screen">
      <h1>Documents</h1>
      <p className="lead">
        Import documents to chat over them. Files are parsed, split into overlapping chunks, and
        copied into your workspace — everything stays local. Embeddings &amp; document Q&amp;A arrive
        in the next phases.
      </p>

      <div className="actions">
        <button
          className="btn primary"
          disabled={busy === 'import'}
          onClick={() => void onImport('files')}
        >
          {busy === 'import' ? 'Importing…' : 'Import files'}
        </button>
        <button className="btn" disabled={busy === 'import'} onClick={() => void onImport('folder')}>
          Import folder
        </button>
        <button className="btn sm" disabled={busy !== null} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <p className="hint" style={{ marginTop: 10 }}>
        Supported: TXT, Markdown, PDF, DOCX, CSV. {anyActive && 'Ingestion in progress…'}
      </p>

      {error && <p className="hint">⚠ {error}</p>}

      {docs && docs.length === 0 && (
        <div className="card muted">No documents yet. Import files to get started.</div>
      )}

      {docs?.map((d) => (
        <div className="card doc-card" key={d.id}>
          <div className="doc-head">
            <div className="doc-title" title={d.originalPath ?? d.title}>
              {d.title}
            </div>
            <span className={`badge doc-${d.status}`}>{STATUS_LABEL[d.status]}</span>
          </div>
          <div className="doc-meta">
            <span>
              Size <b>{formatSize(d.sizeBytes)}</b>
            </span>
            <span>
              Chunks <b>{d.chunkCount}</b>
            </span>
            <span>
              Type <b>{d.mimeType ?? '—'}</b>
            </span>
          </div>
          {d.status === 'failed' && d.errorMessage && (
            <div className="doc-error">⚠ {d.errorMessage}</div>
          )}
          <div className="doc-actions">
            <button
              className="btn sm"
              disabled={busy !== null || ACTIVE_STATUSES.has(d.status)}
              onClick={() => void run(`reindex-${d.id}`, () => window.api.reindexDocument(d.id))}
              title="Re-parse and re-chunk the stored copy"
            >
              {busy === `reindex-${d.id}` ? 'Re-indexing…' : 'Re-index'}
            </button>
            <button
              className="btn sm"
              disabled={busy !== null || ACTIVE_STATUSES.has(d.status)}
              onClick={() => void run(`delete-${d.id}`, () => window.api.deleteDocument(d.id))}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
