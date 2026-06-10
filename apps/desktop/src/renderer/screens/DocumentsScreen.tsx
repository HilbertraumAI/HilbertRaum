import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, Modal, type BadgeTone } from '../components'
import type { DocumentInfo, DocumentPreview, IngestionStatus } from '@shared/types'

// Documents screen (spec §7.7 / Milestone 4). Import files or a folder via the OS picker
// (opened in the main process), watch each file move through the ingestion statuses, and
// delete / re-index documents. Import runs async in the backend; this screen polls
// getImportJob + listDocuments while a job is in flight (BUILD_STATE: async-with-polling).

// Status pills: icon + word, never color-only (guidelines §6). Labels speak human
// (§7) — the pipeline stages (extract/chunk/embed) read as "Reading"/"Preparing";
// the raw stage names stay in logs/Diagnostics.
const STATUS_BADGE: Record<IngestionStatus, { label: string; tone: BadgeTone; icon: string }> = {
  queued: { label: 'Waiting', tone: 'accent', icon: '…' },
  extracting: { label: 'Reading', tone: 'accent', icon: '⟳' },
  chunking: { label: 'Preparing', tone: 'accent', icon: '⟳' },
  embedding: { label: 'Preparing', tone: 'accent', icon: '⟳' },
  indexed: { label: 'Ready', tone: 'success', icon: '✓' },
  failed: { label: 'Failed', tone: 'error', icon: '⚠' },
  deleted: { label: 'Deleted', tone: 'neutral', icon: '—' }
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

interface Props {
  /** "Ask these documents" (Phase 17, spec §10.4): open Chat scoped to the selection. */
  onAskSelected?: (documentIds: string[]) => void
}

export function DocumentsScreen({ onAskSelected }: Props = {}): JSX.Element {
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<DocumentPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // Destructive delete goes through a ConfirmDialog (guidelines §6), not browser confirm.
  const [confirmDelete, setConfirmDelete] = useState<DocumentInfo | null>(null)
  // "Ask these documents" selection (indexed documents only).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.api.listDocuments()
    setDocs(next)
    // Drop selected ids that no longer exist or are no longer indexed.
    setSelected((prev) => {
      const valid = new Set(next.filter((d) => d.status === 'indexed').map((d) => d.id))
      const kept = [...prev].filter((id) => valid.has(id))
      return kept.length === prev.size ? prev : new Set(kept)
    })
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

  // Read-only in-app preview: the extracted text, never the raw file in an external
  // viewer (in encrypted workspaces the stored copy must stay encrypted on disk).
  async function onPreview(d: DocumentInfo): Promise<void> {
    setError(null)
    setPreviewLoading(true)
    try {
      setPreview(await window.api.previewDocument(d.id))
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setPreviewLoading(false)
    }
  }

  const anyActive = docs?.some((d) => ACTIVE_STATUSES.has(d.status)) ?? false
  const staleDocs = docs?.filter((d) => d.staleEmbeddings) ?? []
  const empty = docs != null && docs.length === 0

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Re-index every stale document sequentially (plan §5.2): same per-document call as
  // the row button, one at a time — multi-document re-embedding contends on the embedder.
  async function onReindexAllStale(): Promise<void> {
    setBusy('reindex-all')
    setError(null)
    try {
      for (const d of staleDocs) {
        await window.api.reindexDocument(d.id)
        await refresh()
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
      await refresh().catch(() => undefined)
    }
  }

  return (
    <div className="screen">
      <h1>Documents</h1>
      <p className="lead">
        Import documents to ask questions about them. Each file is copied into your workspace
        and prepared for search — everything stays on this drive. Ask from the Chat
        screen&apos;s &quot;Ask my documents&quot; mode.
      </p>

      {/* When the list is empty the EmptyState below carries the primary action. */}
      {!empty && (
        <div className="actions">
          <Button variant="primary" disabled={busy === 'import'} onClick={() => void onImport('files')}>
            {busy === 'import' ? 'Importing…' : 'Import files'}
          </Button>
          <Button disabled={busy === 'import'} onClick={() => void onImport('folder')}>
            Import folder
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>
            Refresh
          </Button>
          {onAskSelected && selected.size > 0 && (
            <Button
              variant="primary"
              disabled={busy !== null}
              title="Open a document Q&A scoped to the selected documents"
              onClick={() => onAskSelected([...selected])}
            >
              Ask these documents ({selected.size})
            </Button>
          )}
          {staleDocs.length > 1 && (
            <Button
              disabled={busy !== null || anyActive}
              title="Re-index every document that was indexed with a different search model"
              onClick={() => void onReindexAllStale()}
            >
              {busy === 'reindex-all' ? 'Re-indexing…' : `Re-index all (${staleDocs.length})`}
            </Button>
          )}
        </div>
      )}

      <p className="hint" style={{ marginTop: 10 }}>
        Supported: TXT, Markdown, PDF, DOCX, CSV.{' '}
        {anyActive && 'Preparing your documents so you can ask about them…'}
      </p>

      {error && <Banner tone="error">{error}</Banner>}

      {empty && (
        <EmptyState
          title="No documents yet"
          line="Import files to ask questions about them — everything stays on this drive."
          action={
            <>
              <Button variant="primary" disabled={busy === 'import'} onClick={() => void onImport('files')}>
                {busy === 'import' ? 'Importing…' : 'Import files'}
              </Button>
              <Button disabled={busy === 'import'} onClick={() => void onImport('folder')}>
                Import folder
              </Button>
            </>
          }
        />
      )}

      {docs?.map((d) => (
        <div className="card doc-card" key={d.id}>
          <div className="doc-head">
            {onAskSelected && d.status === 'indexed' && (
              <input
                type="checkbox"
                className="doc-select"
                checked={selected.has(d.id)}
                aria-label={`Select ${d.title} for asking`}
                title="Select to ask only chosen documents"
                onChange={() => toggleSelected(d.id)}
              />
            )}
            <div className="doc-title" title={d.originalPath ?? d.title}>
              {d.title}
            </div>
            <Badge tone={STATUS_BADGE[d.status].tone} icon={STATUS_BADGE[d.status].icon}>
              {STATUS_BADGE[d.status].label}
            </Badge>
          </div>
          <div className="doc-meta">
            <span>
              Size <b>{formatSize(d.sizeBytes)}</b>
            </span>
            <span>
              Sections <b>{d.chunkCount}</b>
            </span>
            <span>
              Type <b>{d.mimeType ?? '—'}</b>
            </span>
          </div>
          {d.status === 'failed' && d.errorMessage && <Banner tone="error">{d.errorMessage}</Banner>}
          {d.staleEmbeddings && (
            <Banner tone="warning">
              This document was prepared with a different search model — re-index it so answers
              can find it.
            </Banner>
          )}
          <div className="doc-actions">
            <Button
              size="sm"
              disabled={busy !== null || previewLoading || ACTIVE_STATUSES.has(d.status)}
              onClick={() => void onPreview(d)}
              title="Read the extracted text (read-only; nothing leaves the app)"
            >
              {previewLoading ? 'Opening…' : 'Preview'}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null || ACTIVE_STATUSES.has(d.status)}
              onClick={() => void run(`reindex-${d.id}`, () => window.api.reindexDocument(d.id))}
              title="Read and prepare the stored copy again"
            >
              {busy === `reindex-${d.id}` ? 'Re-indexing…' : 'Re-index'}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null || ACTIVE_STATUSES.has(d.status)}
              onClick={() => setConfirmDelete(d)}
            >
              Delete
            </Button>
          </div>
        </div>
      ))}

      <ConfirmDialog
        open={confirmDelete != null}
        title={`Delete "${confirmDelete?.title ?? ''}"?`}
        confirmLabel="Delete"
        onConfirm={() => {
          const d = confirmDelete
          setConfirmDelete(null)
          if (d) void run(`delete-${d.id}`, () => window.api.deleteDocument(d.id))
        }}
        onCancel={() => setConfirmDelete(null)}
      >
        <p className="hint">
          This permanently removes the document, its extracted text, and its search index from
          your workspace. The original file outside the workspace is not touched.
        </p>
      </ConfirmDialog>

      {preview && <PreviewModal preview={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

/**
 * Read-only document preview: the parser's extracted text segments, grouped under their
 * page/section labels. Shows extracted TEXT (what the AI reads), not the original
 * layout — in encrypted workspaces the original bytes never leave the vault.
 */
function PreviewModal({ preview, onClose }: { preview: DocumentPreview; onClose: () => void }): JSX.Element {
  return (
    <Modal open title={preview.title} ariaLabel={`Preview of ${preview.title}`} width="wide" onClose={onClose}>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Read-only extracted text — this is what document search and answers are based on.
      </p>
      <div className="modal-body">
        {preview.segments.length === 0 && (
          <p className="hint">No text could be extracted from this document.</p>
        )}
        {preview.segments.map((s, i) => (
          <div key={i} className="preview-segment">
            {(s.pageNumber != null || s.sectionLabel) && (
              <div className="preview-label">
                {s.pageNumber != null ? `Page ${s.pageNumber}` : s.sectionLabel}
              </div>
            )}
            <div className="preview-text">{s.text}</div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
