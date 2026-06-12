import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, Modal, type BadgeTone } from '../components'
import type {
  DocTaskKind,
  DocumentInfo,
  DocumentOcrInfo,
  DocumentPreview,
  DocumentSummary,
  IngestionStatus,
  TranslationTargetLang
} from '@shared/types'
import {
  acknowledgeDocTask,
  cancelActiveDocTask,
  getActiveDocTask,
  isDocTaskTerminal,
  startTask,
  subscribeDocTask
} from '../lib/doctasks'
import { friendlyIpcError } from '../lib/errors'

// Documents screen (spec §7.7). Import files or a folder via the OS picker
// (opened in the main process), watch each file move through the ingestion statuses, and
// delete / re-index documents. Import runs async in the backend; this screen polls
// getImportJob + listDocuments while a job is in flight (async-with-polling).

// Status pills: icon + word, never color-only (guidelines §6). Labels speak
// human — the pipeline stages (extract/chunk/embed) read as "Reading"/"Preparing";
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

/**
 * Per-document status badge. Audio in `extracting` is honestly "Transcribing…" —
 * listening to a recording takes real time — with the coarse percent the
 * docs IPC merges in while whisper works.
 */
function badgeFor(d: DocumentInfo): { label: string; tone: BadgeTone; icon: string } {
  const base = STATUS_BADGE[d.status]
  if (d.status === 'extracting' && d.mimeType?.startsWith('audio/')) {
    const pct = d.transcriptionProgress != null ? ` ${d.transcriptionProgress}%` : ''
    return { ...base, label: `Transcribing…${pct}` }
  }
  return base
}

/**
 * Total picked audio bytes above which the import asks first: the
 * recording is copied onto the drive (encrypted on encrypted workspaces) AND fully
 * transcribed on the CPU — real space + real minutes the user should consciously accept.
 */
const LARGE_AUDIO_CONFIRM_BYTES = 50 * 1024 * 1024

// Per-kind busy copy for the row spinner (guidelines §7 — speak human, no jargon).
const TASK_BUSY_LABEL: Record<DocTaskKind, string> = {
  summary: 'Summarizing…',
  translation: 'Translating…',
  compare: 'Comparing…',
  ocr: 'Reading the scan…'
}
const TASK_BUSY_TITLE: Record<DocTaskKind, string> = {
  summary: 'The summary is being written',
  translation: 'The translation is being written',
  compare: 'The comparison is being written',
  ocr: 'The scanned pages are being read'
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  /** "Ask these documents" (spec §10.4): open Chat scoped to the selection. */
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
  // Large-audio import confirmation: pending paths + their preflight.
  const [confirmAudio, setConfirmAudio] = useState<{
    paths: string[]
    audioFileCount: number
    audioBytes: number
  } | null>(null)
  // "Translate" target choice: the row button opens this small modal.
  const [translateDoc, setTranslateDoc] = useState<DocumentInfo | null>(null)
  // OCR availability (availability-driven, no settings key): gates "Make searchable
  // (OCR)" and the photo-import mention. Read once — the language files don't appear
  // mid-session.
  const [ocrAvailable, setOcrAvailable] = useState(false)
  // "Ask these documents" selection (indexed documents only).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // The single active document task — module-level store so a running summary's
  // busy/progress state survives navigating away and back.
  const activeTask = useSyncExternalStore(subscribeDocTask, getActiveDocTask)

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
    void (async () => {
      try {
        setOcrAvailable((await window.api.getAppStatus()).ocrAvailable)
      } catch {
        // No status (partial test bridge) → keep the safe default: no OCR offer.
      }
    })()
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

  async function startImport(paths: string[]): Promise<void> {
    try {
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
      setError(friendlyIpcError(e))
    }
  }

  async function onImport(mode: 'files' | 'folder'): Promise<void> {
    setError(null)
    try {
      const paths = await window.api.pickDocuments(mode)
      if (paths.length === 0) return
      // Size-aware audio gate: large recordings cost drive space
      // (the workspace copy) and real transcription time — ask first.
      const pre = await window.api.importPreflight(paths)
      if (pre.audioBytes >= LARGE_AUDIO_CONFIRM_BYTES) {
        setConfirmAudio({ paths, audioFileCount: pre.audioFileCount, audioBytes: pre.audioBytes })
        return
      }
      await startImport(paths)
    } catch (e) {
      setBusy(null)
      setError(friendlyIpcError(e))
    }
  }

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(friendlyIpcError(e))
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
      setError(friendlyIpcError(e))
    } finally {
      setPreviewLoading(false)
    }
  }

  // When the active task finishes: refresh the list, then show the outcome — a done
  // summary auto-opens the preview with the fresh summary (the one-click promise); a
  // done comparison opens the NEW report document (its provenance line names both
  // sources); a done translation reveals the new document in the refreshed list.
  // Failures show the friendly copy; then clear the store entry.
  useEffect(() => {
    if (!activeTask || !isDocTaskTerminal(activeTask.status)) return
    const status = activeTask.status
    const kind = activeTask.kind
    const openId =
      kind === 'summary' || kind === 'ocr'
        ? activeTask.documentIds[0]
        : kind === 'compare'
          ? status?.resultRef?.documentId
          : null
    acknowledgeDocTask()
    void refresh().catch(() => undefined)
    if (status?.state === 'done' && openId) {
      void window.api
        .previewDocument(openId)
        .then(setPreview)
        .catch(() => undefined)
    } else if (status?.state === 'failed' && status.error) {
      setError(status.error)
    }
  }, [activeTask, refresh])

  async function onSummarize(d: DocumentInfo): Promise<void> {
    setError(null)
    setPreview(null)
    try {
      await startTask('summary', d.id)
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  // "Make searchable (OCR)": explicit, never automatic — reading a
  // scanned PDF page by page takes real time on the CPU.
  async function onMakeSearchable(d: DocumentInfo): Promise<void> {
    setError(null)
    setPreview(null)
    try {
      await startTask('ocr', d.id)
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  async function onTranslate(d: DocumentInfo, targetLang: TranslationTargetLang): Promise<void> {
    setTranslateDoc(null)
    setError(null)
    setPreview(null)
    try {
      await startTask('translation', d.id, { targetLang })
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  // Compare the two selected documents: A = first selected, B = second.
  async function onCompare(): Promise<void> {
    const ids = [...selected]
    if (ids.length !== 2) return
    setError(null)
    setPreview(null)
    try {
      await startTask('compare', ids)
      setSelected(new Set())
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  // Save a document's stored text (e.g. a translation) to a user-chosen file.
  async function onExport(d: DocumentInfo): Promise<void> {
    setError(null)
    try {
      await window.api.exportDocument(d.id)
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  /** A source document's title for a provenance line (the source may be gone). */
  function titleOf(id: string): string {
    return docs?.find((x) => x.id === id)?.title ?? 'a removed document'
  }

  /** Quiet provenance line for a generated document (translation or comparison). */
  function provenanceLine(d: DocumentInfo): ReactNode {
    if (!d.origin) return null
    if (d.origin.type === 'compare') {
      const [a, b] = d.origin.comparedFrom
      return (
        <>
          Comparison of <b>{titleOf(a)}</b> and <b>{titleOf(b)}</b>
        </>
      )
    }
    return (
      <>
        Translated from <b>{titleOf(d.origin.translatedFrom)}</b>
      </>
    )
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

  // Re-index every stale document sequentially: same per-document call as
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
      setError(friendlyIpcError(e))
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
          {selected.size === 2 && (
            <Button
              disabled={busy !== null || activeTask !== null}
              title="Write a comparison of the two selected documents with the local model — nothing leaves this drive"
              onClick={() => void onCompare()}
            >
              Compare (2)
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
        Supported: TXT, Markdown, PDF, DOCX, CSV — audio recordings (WAV, MP3, FLAC, OGG),
        which are transcribed on this drive
        {ocrAvailable && ', and photos of pages (PNG, JPG), which are read on this drive'}
        .{' '}
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
            <Badge tone={badgeFor(d).tone} icon={badgeFor(d).icon}>
              {badgeFor(d).label}
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
            {d.summary && (
              <span>
                Summary <b>✓</b>
              </span>
            )}
          </div>
          {d.origin && (
            <p className="hint" style={{ margin: '2px 0 0' }}>
              {provenanceLine(d)}
            </p>
          )}
          {d.status === 'failed' && d.errorMessage && (
            <Banner tone={d.scanDetected ? 'warning' : 'error'}>
              {d.errorMessage}
              {d.scanDetected &&
                (ocrAvailable
                  ? ' Use "Make searchable (OCR)" below to read the pages on this drive.'
                  : ' Making it searchable needs the OCR files, which are not on this drive.')}
            </Banner>
          )}
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
            {/* "Make searchable (OCR)" for a detected scan. The same
                slot shows the busy/cancel pair while the OCR task runs. */}
            {d.scanDetected &&
              ocrAvailable &&
              (activeTask &&
              activeTask.documentIds.includes(d.id) &&
              !isDocTaskTerminal(activeTask.status) ? (
                <>
                  <Button size="sm" disabled title={TASK_BUSY_TITLE[activeTask.kind]}>
                    <span className="spinner" /> {TASK_BUSY_LABEL[activeTask.kind]}
                    {activeTask.status && activeTask.status.progress.stepsTotal > 1
                      ? ` (${activeTask.status.progress.stepsDone}/${activeTask.status.progress.stepsTotal})`
                      : ''}
                  </Button>
                  <Button size="sm" onClick={() => void cancelActiveDocTask()} title="Stop reading the scan">
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={busy !== null || activeTask !== null}
                  onClick={() => void onMakeSearchable(d)}
                  title="Read the scanned pages with local text recognition — nothing leaves this drive"
                >
                  Make searchable (OCR)
                </Button>
              ))}
            {d.status === 'indexed' &&
              d.chunkCount > 0 &&
              (activeTask &&
              activeTask.documentIds.includes(d.id) &&
              !isDocTaskTerminal(activeTask.status) ? (
                <>
                  <Button size="sm" disabled title={TASK_BUSY_TITLE[activeTask.kind]}>
                    <span className="spinner" /> {TASK_BUSY_LABEL[activeTask.kind]}
                    {activeTask.status && activeTask.status.progress.stepsTotal > 1
                      ? ` (${activeTask.status.progress.stepsDone}/${activeTask.status.progress.stepsTotal})`
                      : ''}
                  </Button>
                  <Button size="sm" onClick={() => void cancelActiveDocTask()} title="Stop the task">
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={busy !== null || activeTask !== null}
                    onClick={() => void onSummarize(d)}
                    title="Write a summary with the local model — nothing leaves this drive"
                  >
                    {d.summary ? 'Summarize again' : 'Summarize'}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null || activeTask !== null}
                    onClick={() => setTranslateDoc(d)}
                    title="Translate with the local model — nothing leaves this drive"
                  >
                    Translate
                  </Button>
                </>
              ))}
            {d.origin && (
              <Button
                size="sm"
                disabled={busy !== null || ACTIVE_STATUSES.has(d.status)}
                onClick={() => void onExport(d)}
                title="Save this document as a Markdown file"
              >
                Export
              </Button>
            )}
            <Button
              size="sm"
              disabled={
                busy !== null || ACTIVE_STATUSES.has(d.status) || (activeTask?.documentIds.includes(d.id) ?? false)
              }
              onClick={() => void run(`reindex-${d.id}`, () => window.api.reindexDocument(d.id))}
              title="Read and prepare the stored copy again"
            >
              {busy === `reindex-${d.id}` ? 'Re-indexing…' : 'Re-index'}
            </Button>
            <Button
              size="sm"
              disabled={
                busy !== null || ACTIVE_STATUSES.has(d.status) || (activeTask?.documentIds.includes(d.id) ?? false)
              }
              onClick={() => setConfirmDelete(d)}
            >
              Delete
            </Button>
          </div>
        </div>
      ))}

      <ConfirmDialog
        open={confirmAudio != null}
        title="Import large audio?"
        confirmLabel="Import and transcribe"
        onConfirm={() => {
          const pending = confirmAudio
          setConfirmAudio(null)
          if (pending) void startImport(pending.paths)
        }}
        onCancel={() => setConfirmAudio(null)}
      >
        <p className="hint">
          {confirmAudio &&
            `This selection contains ${confirmAudio.audioFileCount} audio ${
              confirmAudio.audioFileCount === 1 ? 'recording' : 'recordings'
            } (${formatSize(confirmAudio.audioBytes)}). `}
          Each recording is copied into your workspace and transcribed on this drive —
          a long recording can take a while. You can keep using the app meanwhile.
        </p>
      </ConfirmDialog>

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

      {translateDoc && (
        <Modal
          open
          title={`Translate "${translateDoc.title}"`}
          ariaLabel={`Translate ${translateDoc.title}`}
          onClose={() => setTranslateDoc(null)}
        >
          <p className="hint" style={{ marginTop: 0 }}>
            The local model writes a translated copy as a new document — searchable and
            askable like any import, and nothing leaves this drive. Machine translations
            can contain errors.
          </p>
          <div className="actions">
            <Button variant="primary" onClick={() => void onTranslate(translateDoc, 'de')}>
              To German (Deutsch)
            </Button>
            <Button variant="primary" onClick={() => void onTranslate(translateDoc, 'en')}>
              To English
            </Button>
            <Button onClick={() => setTranslateDoc(null)}>Cancel</Button>
          </div>
        </Modal>
      )}

      {preview && (
        <PreviewModal
          preview={preview}
          ocr={docs?.find((x) => x.id === preview.id)?.ocr ?? null}
          summary={docs?.find((x) => x.id === preview.id)?.summary ?? null}
          originLine={(() => {
            const d = docs?.find((x) => x.id === preview.id)
            return d ? provenanceLine(d) : null
          })()}
          regenerateDisabled={busy !== null || activeTask !== null}
          onRegenerate={() => {
            const d = docs?.find((x) => x.id === preview.id)
            setPreview(null)
            if (d) void onSummarize(d)
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}

/** "Generated by <model> · <date>" — the summary attribution line. */
function summaryAttribution(s: DocumentSummary): string {
  const date = s.createdAt ? new Date(s.createdAt) : null
  const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : ''
  return `Generated by ${s.modelId}${when ? ` · ${when}` : ''}`
}

/**
 * Read-only document preview: the parser's extracted text segments, grouped under their
 * page/section labels. Shows extracted TEXT (what the AI reads), not the original
 * layout — in encrypted workspaces the original bytes never leave the vault.
 * When the document has a persisted summary, it leads in a collapsible
 * section with the model/date attribution and a Regenerate action.
 */
function PreviewModal({
  preview,
  ocr,
  summary,
  originLine,
  regenerateDisabled,
  onRegenerate,
  onClose
}: {
  preview: DocumentPreview
  /** Recognition metadata when the text came from local OCR, or null. */
  ocr?: DocumentOcrInfo | null
  summary?: DocumentSummary | null
  /** Provenance line when this is a generated document, or null. */
  originLine?: ReactNode
  regenerateDisabled?: boolean
  onRegenerate?: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <Modal open title={preview.title} ariaLabel={`Preview of ${preview.title}`} width="wide" onClose={onClose}>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Read-only extracted text — this is what document search and answers are based on.
      </p>
      {ocr && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Text recognized on this drive (OCR) — {ocr.pageCount}{' '}
          {ocr.pageCount === 1 ? 'page' : 'pages'}. Recognition can contain errors.
        </p>
      )}
      {originLine && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          {originLine}
        </p>
      )}
      {summary && (
        <details className="doc-summary" open>
          <summary>Summary</summary>
          <div className="doc-summary-body">
            <p className="hint" style={{ margin: 0 }}>
              {summaryAttribution(summary)}
            </p>
            {summary.truncated && (
              <Banner tone="warning">
                This document is long — the summary covers its beginning. The rest is still
                searchable and answerable in chat.
              </Banner>
            )}
            <div className="preview-text">{summary.text}</div>
            {onRegenerate && (
              <div className="actions" style={{ marginTop: 4 }}>
                <Button size="sm" disabled={regenerateDisabled} onClick={onRegenerate}>
                  Regenerate
                </Button>
              </div>
            )}
          </div>
        </details>
      )}
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
