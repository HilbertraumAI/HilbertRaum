import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, ErrorBanner, Modal, Progress, Spinner, type BadgeTone } from '../components'
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
import { localizeServerCopy } from '../lib/displayMap'
import { useT, type I18n } from '../i18n'
import type { MessageKey, UiLanguage } from '@shared/i18n'

// Documents screen (spec §7.7). Import files or a folder via the OS picker
// (opened in the main process), watch each file move through the ingestion statuses, and
// delete / re-index documents. Import runs async in the backend; this screen polls
// getImportJob + listDocuments while a job is in flight (async-with-polling).

// Status pills: icon + word, never color-only (guidelines §6). Labels speak
// human — the pipeline stages (extract/chunk/embed) read as "Reading"/"Preparing";
// the raw stage names stay in logs/Diagnostics. Label values are MessageKeys
// resolved at render (i18n record §5).
const STATUS_BADGE: Record<IngestionStatus, { labelKey: MessageKey; tone: BadgeTone; icon: string }> = {
  queued: { labelKey: 'docs.status.queued', tone: 'accent', icon: '…' },
  extracting: { labelKey: 'docs.status.extracting', tone: 'accent', icon: '⟳' },
  chunking: { labelKey: 'docs.status.preparing', tone: 'accent', icon: '⟳' },
  embedding: { labelKey: 'docs.status.preparing', tone: 'accent', icon: '⟳' },
  indexed: { labelKey: 'docs.status.indexed', tone: 'success', icon: '✓' },
  failed: { labelKey: 'docs.status.failed', tone: 'error', icon: '⚠' },
  deleted: { labelKey: 'docs.status.deleted', tone: 'neutral', icon: '—' }
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
function badgeFor(d: DocumentInfo, t: I18n['t']): { label: string; tone: BadgeTone; icon: string } {
  const base = STATUS_BADGE[d.status]
  if (d.status === 'extracting' && d.mimeType?.startsWith('audio/')) {
    const pct = d.transcriptionProgress != null ? ` ${d.transcriptionProgress}%` : ''
    return { tone: base.tone, icon: base.icon, label: `${t('docs.status.transcribing')}${pct}` }
  }
  return { tone: base.tone, icon: base.icon, label: t(base.labelKey) }
}

/**
 * Total picked audio bytes above which the import asks first: the
 * recording is copied onto the drive (encrypted on encrypted workspaces) AND fully
 * transcribed on the CPU — real space + real minutes the user should consciously accept.
 */
const LARGE_AUDIO_CONFIRM_BYTES = 50 * 1024 * 1024

// Per-kind busy copy for the row spinner (guidelines §7 — speak human, no jargon).
const TASK_BUSY_LABEL: Record<DocTaskKind, MessageKey> = {
  summary: 'docs.task.summaryBusy',
  translation: 'docs.task.translationBusy',
  compare: 'docs.task.compareBusy',
  ocr: 'docs.task.ocrBusy'
}
const TASK_BUSY_TITLE: Record<DocTaskKind, MessageKey> = {
  summary: 'docs.task.summaryBusyTitle',
  translation: 'docs.task.translationBusyTitle',
  compare: 'docs.task.compareBusyTitle',
  ocr: 'docs.task.ocrBusyTitle'
}

// Decimal separator follows the UI language (i18n record §5); units stay as-is.
function formatSize(bytes: number | null, lang: UiLanguage): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const fmt = (n: number): string =>
    n.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} KB`
  return `${fmt(bytes / (1024 * 1024))} MB`
}

interface Props {
  /** "Ask these documents" (spec §10.4): open Chat scoped to the selection. */
  onAskSelected?: (documentIds: string[]) => void
}

export function DocumentsScreen({ onAskSelected }: Props = {}): JSX.Element {
  const { t, tCount, lang } = useT()
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
  // M-U6: re-index-all is multi-minute CPU work — gate it behind a ConfirmDialog and
  // show a determinate Progress bar ("Re-indexing 3 of 12…") instead of a button spinner.
  const [confirmReindexAll, setConfirmReindexAll] = useState(false)
  const [reindexProgress, setReindexProgress] = useState<{ done: number; total: number } | null>(
    null
  )
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
    refresh().catch((e) => setError(friendlyIpcError(e)))
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
          setError(friendlyIpcError(e))
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
        setError(t('docs.error.noSupported'))
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
    return docs?.find((x) => x.id === id)?.title ?? t('docs.removedDocFallback')
  }

  /** Quiet provenance line for a generated document (translation or comparison). */
  function provenanceLine(d: DocumentInfo): ReactNode {
    if (!d.origin) return null
    if (d.origin.type === 'compare') {
      const [a, b] = d.origin.comparedFrom
      return (
        <>
          {t('docs.provenance.compareBefore')}
          <b>{titleOf(a)}</b>
          {t('docs.provenance.compareMiddle')}
          <b>{titleOf(b)}</b>
        </>
      )
    }
    return (
      <>
        {t('docs.provenance.translatedBefore')}
        <b>{titleOf(d.origin.translatedFrom)}</b>
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
  // Confirmed first (M-U6) because it is multi-minute CPU work; a determinate Progress
  // bar reports "Re-indexing N of M…" rather than a bare button spinner.
  async function onReindexAllStale(): Promise<void> {
    const targets = staleDocs // snapshot — refresh() mutates staleDocs as docs clear
    setBusy('reindex-all')
    setError(null)
    setReindexProgress({ done: 0, total: targets.length })
    try {
      for (let i = 0; i < targets.length; i++) {
        await window.api.reindexDocument(targets[i].id)
        setReindexProgress({ done: i + 1, total: targets.length })
        await refresh()
      }
    } catch (e) {
      setError(friendlyIpcError(e))
    } finally {
      setBusy(null)
      setReindexProgress(null)
      await refresh().catch(() => undefined)
    }
  }

  return (
    <div className="screen">
      <h1>{t('docs.title')}</h1>
      <p className="lead">{t('docs.lead')}</p>

      {/* When the list is empty the EmptyState below carries the primary action. */}
      {!empty && (
        <div className="actions">
          <Button variant="primary" disabled={busy === 'import'} onClick={() => void onImport('files')}>
            {busy === 'import' ? t('docs.import.busy') : t('docs.import.files')}
          </Button>
          <Button disabled={busy === 'import'} onClick={() => void onImport('folder')}>
            {t('docs.import.folder')}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>
            {t('docs.refresh')}
          </Button>
          {onAskSelected && selected.size > 0 && (
            <Button
              variant="primary"
              disabled={busy !== null}
              title={t('docs.askSelectedTitle')}
              onClick={() => onAskSelected([...selected])}
            >
              {t('docs.askSelected', { count: selected.size })}
            </Button>
          )}
          {selected.size === 2 && (
            <Button
              disabled={busy !== null || activeTask !== null}
              title={t('docs.compareBtnTitle')}
              onClick={() => void onCompare()}
            >
              {t('docs.compareBtn')}
            </Button>
          )}
          {staleDocs.length > 1 && (
            <Button
              disabled={busy !== null || anyActive}
              title={t('docs.reindexAllTitle')}
              onClick={() => setConfirmReindexAll(true)}
            >
              {busy === 'reindex-all'
                ? t('docs.reindexBusy')
                : t('docs.reindexAll', { count: staleDocs.length })}
            </Button>
          )}
        </div>
      )}

      {reindexProgress && (
        <Progress
          label={t('docs.reindexAllProgress', {
            done: reindexProgress.done,
            total: reindexProgress.total
          })}
          value={reindexProgress.done}
          max={reindexProgress.total}
        />
      )}

      <p className="hint" style={{ marginTop: 10 }}>
        {t('docs.supported.base')}
        {ocrAvailable && t('docs.supported.ocrExtra')}
        .{' '}
        {anyActive && t('docs.preparing')}
      </p>

      {/* Always-mounted alert region (audit M-U1) — announced on first appearance. */}
      <ErrorBanner message={error} t={t} />

      {empty && (
        <EmptyState
          title={t('docs.empty.title')}
          line={t('docs.empty.line')}
          action={
            <>
              <Button variant="primary" disabled={busy === 'import'} onClick={() => void onImport('files')}>
                {busy === 'import' ? t('docs.import.busy') : t('docs.import.files')}
              </Button>
              <Button disabled={busy === 'import'} onClick={() => void onImport('folder')}>
                {t('docs.import.folder')}
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
                aria-label={t('docs.selectAria', { title: d.title })}
                title={t('docs.selectTitle')}
                onChange={() => toggleSelected(d.id)}
              />
            )}
            <div className="doc-title" title={d.originalPath ?? d.title}>
              {d.title}
            </div>
            <Badge tone={badgeFor(d, t).tone} icon={badgeFor(d, t).icon}>
              {badgeFor(d, t).label}
            </Badge>
          </div>
          <div className="doc-meta">
            <span>
              {t('docs.meta.size')} <b>{formatSize(d.sizeBytes, lang)}</b>
            </span>
            <span>
              {t('docs.meta.sections')} <b>{d.chunkCount}</b>
            </span>
            <span>
              {t('docs.meta.type')} <b>{d.mimeType ?? '—'}</b>
            </span>
            {d.summary && (
              <span>
                {t('docs.meta.summary')} <b>✓</b>
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
              {/* error_message is persisted canonical English; the D-L4 display map
                  translates the known constants — unknown strings render as-is. */}
              {localizeServerCopy(t, d.errorMessage)}
              {d.scanDetected && (
                <>
                  {' '}
                  {ocrAvailable ? t('docs.scan.ocrOffer') : t('docs.scan.ocrMissing')}
                </>
              )}
            </Banner>
          )}
          {d.staleEmbeddings && <Banner tone="warning">{t('docs.stale.banner')}</Banner>}
          <div className="doc-actions">
            <Button
              size="sm"
              disabled={busy !== null || previewLoading || ACTIVE_STATUSES.has(d.status)}
              onClick={() => void onPreview(d)}
              title={t('docs.previewTitle')}
            >
              {previewLoading ? t('docs.previewBusy') : t('docs.preview')}
            </Button>
            {/* "Make searchable (OCR)" for a detected scan. The same
                slot shows the busy/cancel pair while the OCR task runs. */}
            {d.scanDetected &&
              ocrAvailable &&
              (activeTask &&
              activeTask.documentIds.includes(d.id) &&
              !isDocTaskTerminal(activeTask.status) ? (
                <>
                  <Button size="sm" disabled title={t(TASK_BUSY_TITLE[activeTask.kind])}>
                    <Spinner /> {t(TASK_BUSY_LABEL[activeTask.kind])}
                    {activeTask.status && activeTask.status.progress.stepsTotal > 1
                      ? ` (${activeTask.status.progress.stepsDone}/${activeTask.status.progress.stepsTotal})`
                      : ''}
                  </Button>
                  <Button size="sm" onClick={() => void cancelActiveDocTask()} title={t('docs.cancelOcrTitle')}>
                    {t('docs.cancel')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={busy !== null || activeTask !== null}
                  onClick={() => void onMakeSearchable(d)}
                  title={t('docs.makeSearchableTitle')}
                >
                  {t('docs.makeSearchable')}
                </Button>
              ))}
            {d.status === 'indexed' &&
              d.chunkCount > 0 &&
              (activeTask &&
              activeTask.documentIds.includes(d.id) &&
              !isDocTaskTerminal(activeTask.status) ? (
                <>
                  <Button size="sm" disabled title={t(TASK_BUSY_TITLE[activeTask.kind])}>
                    <Spinner /> {t(TASK_BUSY_LABEL[activeTask.kind])}
                    {activeTask.status && activeTask.status.progress.stepsTotal > 1
                      ? ` (${activeTask.status.progress.stepsDone}/${activeTask.status.progress.stepsTotal})`
                      : ''}
                  </Button>
                  <Button size="sm" onClick={() => void cancelActiveDocTask()} title={t('docs.cancelTaskTitle')}>
                    {t('docs.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={busy !== null || activeTask !== null}
                    onClick={() => void onSummarize(d)}
                    title={t('docs.summarizeTitle')}
                  >
                    {d.summary ? t('docs.summarizeAgain') : t('docs.summarize')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null || activeTask !== null}
                    onClick={() => setTranslateDoc(d)}
                    title={t('docs.translateTitle')}
                  >
                    {t('docs.translate')}
                  </Button>
                </>
              ))}
            {d.origin && (
              <Button
                size="sm"
                disabled={busy !== null || ACTIVE_STATUSES.has(d.status)}
                onClick={() => void onExport(d)}
                title={t('docs.exportTitle')}
              >
                {t('docs.export')}
              </Button>
            )}
            <Button
              size="sm"
              disabled={
                busy !== null || ACTIVE_STATUSES.has(d.status) || (activeTask?.documentIds.includes(d.id) ?? false)
              }
              onClick={() => void run(`reindex-${d.id}`, () => window.api.reindexDocument(d.id))}
              title={t('docs.reindexTitle')}
            >
              {busy === `reindex-${d.id}` ? t('docs.reindexBusy') : t('docs.reindex')}
            </Button>
            <Button
              size="sm"
              disabled={
                busy !== null || ACTIVE_STATUSES.has(d.status) || (activeTask?.documentIds.includes(d.id) ?? false)
              }
              onClick={() => setConfirmDelete(d)}
            >
              {t('docs.delete')}
            </Button>
          </div>
        </div>
      ))}

      <ConfirmDialog
        open={confirmAudio != null}
        title={t('docs.audioConfirm.title')}
        confirmLabel={t('docs.audioConfirm.confirm')}
        t={t}
        onConfirm={() => {
          const pending = confirmAudio
          setConfirmAudio(null)
          if (pending) void startImport(pending.paths)
        }}
        onCancel={() => setConfirmAudio(null)}
      >
        <p className="hint">
          {confirmAudio && (
            <>
              {tCount('docs.audioConfirm.contains', confirmAudio.audioFileCount, {
                size: formatSize(confirmAudio.audioBytes, lang)
              })}{' '}
            </>
          )}
          {t('docs.audioConfirm.body')}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDelete != null}
        title={t('docs.deleteConfirm.title', { title: confirmDelete?.title ?? '' })}
        confirmLabel={t('docs.delete')}
        t={t}
        onConfirm={() => {
          const d = confirmDelete
          setConfirmDelete(null)
          if (d) void run(`delete-${d.id}`, () => window.api.deleteDocument(d.id))
        }}
        onCancel={() => setConfirmDelete(null)}
      >
        <p className="hint">{t('docs.deleteConfirm.body')}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmReindexAll}
        title={t('docs.reindexAllConfirm.title', { count: staleDocs.length })}
        confirmLabel={t('docs.reindexAllConfirm.confirm')}
        t={t}
        onConfirm={() => {
          setConfirmReindexAll(false)
          void onReindexAllStale()
        }}
        onCancel={() => setConfirmReindexAll(false)}
      >
        <p className="hint">{t('docs.reindexAllConfirm.body')}</p>
      </ConfirmDialog>

      {translateDoc && (
        <Modal
          open
          title={t('docs.translateModal.title', { title: translateDoc.title })}
          ariaLabel={t('docs.translateModal.aria', { title: translateDoc.title })}
          onClose={() => setTranslateDoc(null)}
          t={t}
        >
          <p className="hint" style={{ marginTop: 0 }}>
            {t('docs.translateModal.hint')}
          </p>
          <div className="actions">
            <Button variant="primary" onClick={() => void onTranslate(translateDoc, 'de')}>
              {t('docs.translateModal.toGerman')}
            </Button>
            <Button variant="primary" onClick={() => void onTranslate(translateDoc, 'en')}>
              {t('docs.translateModal.toEnglish')}
            </Button>
            <Button onClick={() => setTranslateDoc(null)}>{t('docs.cancel')}</Button>
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
function summaryAttribution(s: DocumentSummary, t: I18n['t'], lang: UiLanguage): string {
  const date = s.createdAt ? new Date(s.createdAt) : null
  const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(lang) : ''
  return `${t('docs.previewModal.generatedBy', { model: s.modelId })}${when ? ` · ${when}` : ''}`
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
  const { t, tCount, lang } = useT()
  return (
    <Modal
      open
      title={preview.title}
      ariaLabel={t('docs.previewModal.aria', { title: preview.title })}
      width="wide"
      onClose={onClose}
      t={t}
    >
      <p className="hint" style={{ margin: '0 0 8px' }}>
        {t('docs.previewModal.hint')}
      </p>
      {ocr && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          {tCount('docs.previewModal.ocrInfo', ocr.pageCount)}
        </p>
      )}
      {originLine && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          {originLine}
        </p>
      )}
      {summary && (
        <details className="doc-summary" open>
          <summary>{t('docs.previewModal.summary')}</summary>
          <div className="doc-summary-body">
            <p className="hint" style={{ margin: 0 }}>
              {summaryAttribution(summary, t, lang)}
            </p>
            {summary.truncated && (
              <Banner tone="warning">{t('docs.previewModal.truncated')}</Banner>
            )}
            <div className="preview-text">{summary.text}</div>
            {onRegenerate && (
              <div className="actions" style={{ marginTop: 4 }}>
                <Button size="sm" disabled={regenerateDisabled} onClick={onRegenerate}>
                  {t('docs.previewModal.regenerate')}
                </Button>
              </div>
            )}
          </div>
        </details>
      )}
      <div className="modal-body">
        {preview.segments.length === 0 && (
          <p className="hint">{t('docs.previewModal.noText')}</p>
        )}
        {preview.segments.map((s, i) => (
          <div key={i} className="preview-segment">
            {(s.pageNumber != null || s.sectionLabel) && (
              <div className="preview-label">
                {s.pageNumber != null
                  ? t('docs.previewModal.page', { page: s.pageNumber })
                  : s.sectionLabel}
              </div>
            )}
            <div className="preview-text">{s.text}</div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
