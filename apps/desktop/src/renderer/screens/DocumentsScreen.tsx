import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Badge, Banner, Button, Chip, ConfirmDialog, CoverageMeter, EmptyState, ErrorBanner, Icon, Modal, Progress, Spinner, TierMenu, useToast, type BadgeTone } from '../components'
import { SourcesDisclosure } from '../chat/SourcesDisclosure'
import { AssistantMarkdown } from '../chat'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type {
  Collection,
  CoverageTier,
  DocTaskKind,
  DocumentCoverage,
  DocumentInfo,
  DocumentLifecycle,
  DocumentOcrInfo,
  DocumentPreview,
  DocumentSummary,
  IngestionStatus,
  TranslationTargetLang
} from '@shared/types'
import { generatedStaleness, matchesSmartView, provenanceView } from '@shared/types'
import {
  acknowledgeDocTask,
  cancelActiveDocTask,
  getActiveDocTask,
  isDocTaskTerminal,
  startTask,
  subscribeDocTask
} from '../lib/doctasks'
import { friendlyIpcError } from '../lib/errors'
import { localizeServerCopy, unsupportedTypeExt } from '../lib/displayMap'
import { useT, type I18n } from '../i18n'
import { en, type MessageKey, type UiLanguage } from '@shared/i18n'

/**
 * A failed import is RETRYABLE when re-indexing could plausibly succeed (a transient read /
 * parse error, an interrupted run). It is NOT retryable when the cause is intrinsic to the
 * file — an unsupported type, or a file too large / too many sections to index — where a
 * re-index would just fail the same way. Matched against the persist-canonical English in
 * `documents.error_message` (the value the D-L4 display map localizes), so the offered action
 * stays honest. Exported for the renderer test.
 */
export function isRetryableFailure(errorMessage: string | null | undefined): boolean {
  const msg = errorMessage ?? ''
  if (!msg) return true // unknown cause → let the user try again
  if (unsupportedTypeExt(msg) != null) return false
  if (msg === en['main.ingest.fileTooLarge'] || msg === en['main.ingest.tooManyChunks']) return false
  return true
}

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

// FE-6: how many preview segments to fetch per page (first page + each "Show more").
const PREVIEW_PAGE_SIZE = 50

// Per-kind busy copy for the row spinner (guidelines §7 — speak human, no jargon).
const TASK_BUSY_LABEL: Record<DocTaskKind, MessageKey> = {
  summary: 'docs.task.summaryBusy',
  translation: 'docs.task.translationBusy',
  compare: 'docs.task.compareBusy',
  ocr: 'docs.task.ocrBusy',
  tree: 'docs.task.treeBusy',
  extract: 'docs.task.extractBusy'
}
const TASK_BUSY_TITLE: Record<DocTaskKind, MessageKey> = {
  summary: 'docs.task.summaryBusyTitle',
  translation: 'docs.task.translationBusyTitle',
  compare: 'docs.task.compareBusyTitle',
  ocr: 'docs.task.ocrBusyTitle',
  tree: 'docs.task.treeBusyTitle',
  extract: 'docs.task.extractBusyTitle'
}

/**
 * Map a stored MIME type to a short, friendly label (§7 — hide the machinery; show "PDF",
 * not "application/pdf"). Display-only: the stored MIME string is never changed, so the
 * copy-tone guard and the ingestion contracts are untouched. Pure ⇒ unit-tested directly.
 */
const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/markdown': 'Markdown',
  'text/plain': 'Text',
  'text/csv': 'CSV',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/msword': 'Word',
  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/flac': 'FLAC',
  'audio/ogg': 'OGG',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG'
}

export function friendlyMimeLabel(mime: string | null | undefined): string {
  if (!mime) return '—'
  const direct = MIME_LABELS[mime]
  if (direct) return direct
  if (mime.startsWith('audio/')) return 'Audio'
  if (mime.startsWith('image/')) return 'Image'
  if (mime.startsWith('text/')) return 'Text'
  // Last resort: the subtype, upper-cased (e.g. application/zip → ZIP).
  const sub = mime.split('/')[1] ?? mime
  return sub.toUpperCase()
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

/**
 * The Documents section-rail selection (plan §12.1). The built-in containers
 * (library/temporary/generated/archived/all) plus a project, plus the Phase-E
 * query-time smart views (recent/unfiled/needsReindex/large/failed/audio/ocr — §7.6).
 */
type DocSection =
  | { kind: 'library' | 'temporary' | 'generated' | 'archived' | 'all' }
  | { kind: 'recent' | 'unfiled' | 'needsReindex' | 'large' | 'failed' | 'audio' | 'ocr' }
  | { kind: 'project'; id: string }

interface Props {
  /** "Ask these documents" (spec §10.4): open Chat scoped to the selection. */
  onAskSelected?: (documentIds: string[]) => void
}

/**
 * Whether a document belongs in the current (non-project) section (plan §12.1). Pure (off the
 * already-listed fields) so the `visibleDocs` useMemo can call it without a per-render closure;
 * the Phase-E smart views route through the shared `matchesSmartView` predicate to keep the rail
 * in lockstep with the `docs:list` filter. 'all'/'recent'/'project' are handled by the caller.
 */
function inSection(d: DocumentInfo, section: DocSection): boolean {
  const lifecycle = d.lifecycle ?? 'permanent'
  switch (section.kind) {
    case 'temporary':
      return lifecycle === 'temporary' || (d.collections ?? []).some((c) => c.type === 'temporary')
    case 'library':
      return (d.collections ?? []).some((c) => c.type === 'library')
    case 'generated':
    case 'archived':
    case 'unfiled':
    case 'needsReindex':
    case 'large':
    case 'failed':
    case 'audio':
    case 'ocr':
      return matchesSmartView(d, section.kind)
    default:
      return true
  }
}

/** Remembered collapse state for the Documents sub-nav (section rail). A UI preference, not
 *  user data → localStorage, outside the encrypted workspace. Exported for tests. */
export const RAIL_COLLAPSED_KEY = 'hilbertraum.docs.railCollapsed'
/** Remembered open/closed state of the Views "More" disclosure (rare diagnostic views). */
export const VIEWS_MORE_KEY = 'hilbertraum.docs.viewsMoreOpen'

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
  // Document-organization (plan §12): the section rail selection + the collections list.
  const [collections, setCollections] = useState<Collection[]>([])
  const [section, setSection] = useState<DocSection>({ kind: 'all' })
  // Sub-nav (section rail) collapse, remembered across sessions (localStorage — a UI
  // preference, NOT user data, so it may live outside the encrypted workspace). Mirrors the
  // chat ConversationList collapse pattern (§11.6). Collapsed ⇒ the list takes the full width.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  // Project management dialogs.
  const [projectModal, setProjectModal] = useState<{ mode: 'create' | 'rename'; id?: string; name: string } | null>(null)
  const [deleteProject, setDeleteProject] = useState<Collection | null>(null)
  // The per-row / bulk "add to project" picker target (documentIds being filed).
  const [addToProjectFor, setAddToProjectFor] = useState<string[] | null>(null)
  // M-U6: re-index-all is multi-minute CPU work — gate it behind a ConfirmDialog and
  // show a determinate Progress bar ("Re-indexing 3 of 12…") instead of a button spinner.
  const [confirmReindexAll, setConfirmReindexAll] = useState(false)
  const [reindexProgress, setReindexProgress] = useState<{ done: number; total: number } | null>(
    null
  )
  // Bulk delete from the selection toolbar (§11.6) — behind a ConfirmDialog like single delete.
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // One controlled per-row "⋯" menu so right-click opens the same overflow (mirrors the
  // chat ConversationList pattern). Holds the open row id, or null.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // The single active document task — module-level store so a running summary's
  // busy/progress state survives navigating away and back.
  const activeTask = useSyncExternalStore(subscribeDocTask, getActiveDocTask)

  const refreshCollections = useCallback(async (): Promise<void> => {
    try {
      setCollections((await window.api.listCollections?.()) ?? [])
    } catch {
      setCollections([])
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.api.listDocuments()
    setDocs(next)
    void refreshCollections()
    // Drop selected ids that no longer exist or are no longer indexed.
    setSelected((prev) => {
      const valid = new Set(next.filter((d) => d.status === 'indexed').map((d) => d.id))
      const kept = [...prev].filter((id) => valid.has(id))
      return kept.length === prev.size ? prev : new Set(kept)
    })
  }, [refreshCollections])

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

  // Poll the import job until ingestion settles (FE-7). The 400 ms tick reads ONLY the small
  // `getImportJob` status; the full `listDocuments` + collections refresh (which re-derives the
  // whole screen) runs only when a file actually finishes — i.e. the job's completed/failed count
  // changes — and once more at completion, instead of every tick. This is the ModelsScreen
  // download-poll pattern (refresh on a status transition, not every poll). The visible list
  // therefore updates at file-completion granularity rather than re-deriving 2.5×/s.
  const watchJob = useCallback(
    (jobId: string): void => {
      if (pollRef.current) clearInterval(pollRef.current)
      let lastSettled = -1
      pollRef.current = setInterval(async () => {
        try {
          const job = await window.api.getImportJob(jobId)
          const settled = job.completed + job.failed
          const transitioned = settled !== lastSettled
          lastSettled = settled
          if (transitioned || job.done) await refresh()
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
      // FE-6: this is the BOUNDED first page (+ cursor), not the whole document.
      setPreview(await window.api.previewDocument(d.id))
    } catch (e) {
      setError(friendlyIpcError(e))
    } finally {
      setPreviewLoading(false)
    }
  }

  // FE-6: append the next preview page (the modal's "Show more"). Reads the cursor off the
  // current `preview` and merges the new slice onto the accumulated segments. A guarded no-op
  // once `nextOffset` is null (last page). Tolerant of a partial test bridge missing the method.
  async function onPreviewLoadMore(): Promise<void> {
    if (!preview || preview.nextOffset == null || !window.api.previewDocumentPage) return
    try {
      const next = await window.api.previewDocumentPage(
        preview.id,
        preview.nextOffset,
        PREVIEW_PAGE_SIZE
      )
      setPreview((cur) =>
        cur && cur.id === next.id
          ? { ...next, segments: [...cur.segments, ...next.segments] }
          : next
      )
    } catch (e) {
      setError(friendlyIpcError(e))
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

  // Re-summarize at a chosen coverage tier (whole-document-analysis §4.5). Tier 1 = 0 model
  // calls (root verbatim); Tier 2/3 reduce precomputed material. The done-task effect
  // re-opens the preview with the fresh summary + coverage.
  async function onSummarizeTier(d: DocumentInfo, tier: CoverageTier): Promise<void> {
    setError(null)
    setPreview(null)
    try {
      await startTask('summary', d.id, { tier })
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  // Build a whole-document deep index (whole-document-analysis §5.2). C4 gate: a legacy
  // (not fully-chunked) document must be re-indexed first so "100%" can never be claimed over
  // a silently-truncated set — the row offers "Re-index for deep index" instead of a dead button.
  async function onBuildDeepIndex(d: DocumentInfo): Promise<void> {
    setError(null)
    try {
      if (d.fullyChunked === false) {
        await run(`reindex-${d.id}`, () => window.api.reindexDocument(d.id))
      } else {
        await startTask('tree', d.id)
      }
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

  /** A source document's title for a provenance line (the source may be gone). FE-8: resolve via
   *  the `sourcesById` Map instead of a linear `docs.find` per provenance line (called once per
   *  generated row + the preview modal). Only ever invoked during row/modal render, after the
   *  `sourcesById` const below is initialized. */
  function titleOf(id: string): string {
    return sourcesById.get(id)?.title ?? t('docs.removedDocFallback')
  }

  /**
   * Quiet provenance line for a generated document, rendered from the structured
   * `GeneratedProvenance` view (kind + source ids) so old and new rows take one path
   * (plan §15.3). Source titles resolve tolerantly — a deleted source falls back to the
   * "removed document" copy.
   */
  function provenanceLine(d: DocumentInfo): ReactNode {
    if (!d.origin) return null
    const { kind, sourceDocumentIds } = provenanceView(d.origin)
    if (kind === 'compare') {
      const [a, b] = sourceDocumentIds
      return (
        <>
          {t('docs.provenance.compareBefore')}
          <b>{titleOf(a)}</b>
          {t('docs.provenance.compareMiddle')}
          <b>{titleOf(b)}</b>
        </>
      )
    }
    const before =
      kind === 'translation'
        ? t('docs.provenance.translatedBefore')
        : kind === 'summary'
          ? t('docs.provenance.summaryBefore')
          : t('docs.provenance.generatedBefore')
    return (
      <>
        {before}
        <b>{titleOf(sourceDocumentIds[0])}</b>
      </>
    )
  }

  // Derived collections (plan §12) — memoized so the render body (re-run on every 400 ms import
  // poll + every unrelated state change: menu/hover/modal) doesn't re-filter the whole list each
  // time (FE-2). Keyed only on the inputs each derivation actually reads.
  const anyActive = useMemo(() => docs?.some((d) => ACTIVE_STATUSES.has(d.status)) ?? false, [docs])
  const staleDocs = useMemo(() => docs?.filter((d) => d.staleEmbeddings) ?? [], [docs])
  const empty = docs != null && docs.length === 0

  // ---- Document-organization: section rail filtering + collection/project actions ----
  const { activeProjects, archivedProjects, libraryCollection, temporaryCollection } = useMemo(() => {
    const projects = collections.filter((c) => c.type === 'project')
    return {
      activeProjects: projects.filter((c) => c.archivedAt == null),
      archivedProjects: projects.filter((c) => c.archivedAt != null),
      libraryCollection: collections.find((c) => c.type === 'library') ?? null,
      temporaryCollection: collections.find((c) => c.type === 'temporary') ?? null
    }
  }, [collections])

  // Source lookup for the generated-staleness derivation (plan §15.3) — pure, off the
  // already-listed fields; no extra read, no hot-path write.
  const sourcesById = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs])

  // FE-8 (perf audit 2026-06-18): resolve the previewed document ONCE (Map lookup) instead of six
  // linear `docs.find(x => x.id === preview.id)` scans across the PreviewModal props below.
  const previewDoc = useMemo(
    () => (preview ? (sourcesById.get(preview.id) ?? null) : null),
    [preview, sourcesById]
  )

  // The section-filtered, optionally-reordered list — recomputed only when the docs or the
  // selected section change (FE-2). "Recently added" is an ordering, not a membership predicate
  // (plan §7.6 — no new column).
  const visibleDocs: DocumentInfo[] = useMemo(() => {
    if (docs == null) return []
    const sectioned =
      section.kind === 'project'
        ? docs.filter((d) => (d.collections ?? []).some((c) => c.id === section.id))
        : docs.filter((d) => inSection(d, section))
    return section.kind === 'recent'
      ? [...sectioned].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      : sectioned
  }, [docs, section])

  // Rail counts for the rare diagnostic views — one bucketing pass over docs instead of the four
  // independent `docs.filter` passes the render body used to run (FE-2).
  const rareCounts = useMemo(() => {
    const counts = { large: 0, failed: 0, audio: 0, ocr: 0 }
    for (const d of docs ?? []) {
      if (matchesSmartView(d, 'large')) counts.large++
      if (matchesSmartView(d, 'failed')) counts.failed++
      if (matchesSmartView(d, 'audio')) counts.audio++
      if (matchesSmartView(d, 'ocr')) counts.ocr++
    }
    return counts
  }, [docs])

  async function runOrg(key: string, fn: () => Promise<unknown>): Promise<void> {
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

  async function onSaveProject(): Promise<void> {
    const m = projectModal
    if (!m) return
    const name = m.name.trim()
    if (!name) return
    setProjectModal(null)
    await runOrg('project', async () => {
      if (m.mode === 'create') {
        const created = await window.api.createCollection(name)
        setSection({ kind: 'project', id: created.id })
      } else if (m.id) {
        await window.api.renameCollection(m.id, name)
      }
    })
  }

  async function onArchiveProject(p: Collection): Promise<void> {
    await runOrg('project', () => window.api.setCollectionArchived(p.id, p.archivedAt == null))
  }

  async function onDeleteProject(mode: 'membershipOnly' | 'withDocuments'): Promise<void> {
    const p = deleteProject
    setDeleteProject(null)
    if (!p) return
    await runOrg('project', async () => {
      await window.api.deleteCollection(p.id, mode)
      if (section.kind === 'project' && section.id === p.id) setSection({ kind: 'all' })
    })
  }

  async function onAddToProject(collectionId: string): Promise<void> {
    const ids = addToProjectFor
    setAddToProjectFor(null)
    if (!ids || ids.length === 0) return
    // Moving a Temporary doc into a project makes it durable (plan §14.1): add the project,
    // set it permanent, and drop Temporary membership. Non-temporary docs are unaffected —
    // the lifecycle/membership ops are scoped to the ids that are actually temporary.
    const tempIds = ids.filter((id) => docs?.find((d) => d.id === id)?.lifecycle === 'temporary')
    await runOrg('org', async () => {
      await window.api.addToCollection(ids, collectionId)
      if (tempIds.length > 0) {
        await window.api.setDocumentLifecycle(tempIds, 'permanent')
        if (temporaryCollection) {
          await window.api.removeFromCollection(tempIds, temporaryCollection.id)
        }
      }
    })
  }

  async function onRemoveFromCollection(documentId: string, collectionId: string): Promise<void> {
    await runOrg('org', () => window.api.removeFromCollection([documentId], collectionId))
  }

  async function onKeepInLibrary(documentId: string): Promise<void> {
    if (!libraryCollection) return
    await runOrg('org', async () => {
      await window.api.addToCollection([documentId], libraryCollection.id)
      await window.api.setDocumentLifecycle([documentId], 'permanent')
      if (temporaryCollection) await window.api.removeFromCollection([documentId], temporaryCollection.id)
    })
  }

  async function onSetLifecycle(documentId: string, lifecycle: DocumentLifecycle): Promise<void> {
    await runOrg('org', () => window.api.setDocumentLifecycle([documentId], lifecycle))
  }

  // Bulk delete the current selection (selection toolbar, §11.6): delete each one at a time
  // (same per-document IPC as the row), then clear the selection and refresh once.
  async function onBulkDelete(): Promise<void> {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy('bulk-delete')
    setError(null)
    try {
      for (const id of ids) await window.api.deleteDocument(id)
      setSelected(new Set())
    } catch (e) {
      setError(friendlyIpcError(e))
    } finally {
      setBusy(null)
      await refresh().catch(() => undefined)
    }
  }

  /**
   * The uniform location/project chips for a row (Task 3): Library / Temporary / Generated /
   * Archived AND project tags all render as the SAME neutral Chip — location is never a status
   * badge or a blue pill. Deduped, in a stable order. Returns plain labels; the caller renders
   * them as <Chip>.
   */
  function rowChips(d: DocumentInfo): string[] {
    const labels: string[] = []
    const push = (s: string): void => {
      if (s && !labels.includes(s)) labels.push(s)
    }
    for (const c of d.collections ?? []) {
      if (c.type === 'library') push(t('docs.chip.library'))
      else if (c.type === 'temporary') push(t('docs.chip.temporary'))
      else push(c.name)
    }
    if ((d.lifecycle ?? 'permanent') === 'temporary') push(t('docs.chip.temporary'))
    if ((d.lifecycle ?? 'permanent') === 'archived') push(t('docs.chip.archived'))
    if (d.origin) push(t('docs.chip.generated'))
    return labels
  }

  /** Compact muted meta line: "PDF · 2.0 KB · 7 sections" (§5/§6 — technical, visually secondary). */
  function metaLine(d: DocumentInfo): string {
    const parts: string[] = [friendlyMimeLabel(d.mimeType)]
    if (d.sizeBytes != null) parts.push(formatSize(d.sizeBytes, lang))
    if (d.chunkCount > 0) parts.push(tCount('docs.meta.sectionsCount', d.chunkCount))
    return parts.join(' · ')
  }

  // Collapse/expand the sub-nav and remember it across sessions (best-effort persist).
  function setRailCollapsedPersistent(collapsed: boolean): void {
    setRailCollapsed(collapsed)
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // Remembering the preference is best-effort.
    }
  }

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
    <div className="screen docs-screen">
      <h1>{t('docs.title')}</h1>
      <p className="lead">{t('docs.lead')}</p>

      <div className={`docs-layout ${railCollapsed ? 'rail-collapsed' : ''}`}>
        {!railCollapsed && (
          <SectionRail
            section={section}
            onSelect={setSection}
            collections={collections}
            activeProjects={activeProjects}
            archivedProjects={archivedProjects}
            rareCounts={rareCounts}
            busy={busy !== null}
            onCollapse={() => setRailCollapsedPersistent(true)}
            onNewProject={() => setProjectModal({ mode: 'create', name: '' })}
            onRenameProject={(p) => setProjectModal({ mode: 'rename', id: p.id, name: p.name })}
            onArchiveProject={(p) => void onArchiveProject(p)}
            onDeleteProject={(p) => setDeleteProject(p)}
            t={t}
          />
        )}
        <div className="docs-main">
      {/* When the sub-nav is collapsed, a quiet "»" handle re-opens it (mirrors the chat
          ConversationList collapse pattern, §11.6); the list takes the full width meanwhile. */}
      {railCollapsed && (
        <button
          type="button"
          className="docs-rail-show"
          aria-label={t('docs.rail.show')}
          title={t('docs.rail.show')}
          onClick={() => setRailCollapsedPersistent(false)}
        >
          »
        </button>
      )}

      {/* Toolbar: Import files (Primary) + Import folder (Secondary) carry the screen;
          Refresh is a quiet icon button (§6/Task 7). Multi-document operations live in the
          selection toolbar below, not here, so the toolbar stays uncluttered. When the list
          is empty the EmptyState carries the primary action instead. */}
      {!empty && (
        <div className="actions">
          <Button variant="primary" disabled={busy === 'import'} onClick={() => void onImport('files')}>
            {busy === 'import' ? t('docs.import.busy') : t('docs.import.files')}
          </Button>
          <Button disabled={busy === 'import'} onClick={() => void onImport('folder')}>
            {t('docs.import.folder')}
          </Button>
          <button
            type="button"
            className="icon-btn"
            disabled={busy !== null}
            aria-label={t('docs.refresh')}
            title={t('docs.refresh')}
            onClick={() => void refresh()}
          >
            <Icon name="refresh" size={18} />
          </button>
          {staleDocs.length > 1 && (
            <Button
              size="sm"
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

      {/* Selection toolbar (Task 6): a single non-stacking sticky bar for the multi-document
          operations — keeps them out of every row so the per-row set stays minimal. */}
      {selected.size > 0 && (
        <div className="docs-selbar" role="group" aria-label={t('docs.selectionAria')}>
          <span className="docs-selbar-count">{tCount('docs.bulk.selected', selected.size)}</span>
          {onAskSelected && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              title={t('docs.askSelectedTitle')}
              onClick={() => onAskSelected([...selected])}
            >
              {t('docs.askSelected', { count: selected.size })}
            </Button>
          )}
          {/* Compare is present whenever there is a selection, but enabled ONLY at exactly two. */}
          <Button
            size="sm"
            disabled={busy !== null || activeTask !== null || selected.size !== 2}
            title={t('docs.compareBtnTitle')}
            onClick={() => void onCompare()}
          >
            {t('docs.compareBtn')}
          </Button>
          {activeProjects.length > 0 && (
            <Button size="sm" disabled={busy !== null} onClick={() => setAddToProjectFor([...selected])}>
              {t('docs.action.moveToProject')}
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void runOrg('org', () => window.api.setDocumentLifecycle([...selected], 'temporary'))}
          >
            {t('docs.action.markTemporary')}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void runOrg('org', () => window.api.setDocumentLifecycle([...selected], 'archived'))}
          >
            {t('docs.action.archive')}
          </Button>
          <Button
            size="sm"
            className="danger"
            disabled={busy !== null}
            onClick={() => setConfirmBulkDelete(true)}
          >
            {t('docs.bulk.delete')}
          </Button>
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

      {docs != null && docs.length > 0 && visibleDocs.length === 0 && (
        <p className="hint">{t('docs.empty.section')}</p>
      )}

      {/* Reading column (§11.6 refinement): the list is capped to a ~1000px max-width, left-
          aligned with the screen's content gutter (NOT centred), so long filenames get room and
          the right-aligned Preview/⋯ column never drifts to a far edge on wide displays. */}
      <div className="doc-list">
      {visibleDocs.map((d) => {
        // One task occupies the runtime at a time; while it targets THIS row, the row shows a
        // busy/cancel pair instead of the Preview + "⋯" pair. `rowTask` is the active task (so
        // it narrows) or null.
        const rowTask =
          activeTask != null &&
          activeTask.documentIds.includes(d.id) &&
          !isDocTaskTerminal(activeTask.status)
            ? activeTask
            : null
        const status = badgeFor(d, t)
        const chips = rowChips(d)
        const canDocTasks = d.status === 'indexed' && d.chunkCount > 0
        const canDeepIndex = canDocTasks && !d.origin && d.treeStatus !== 'ready'
        const showOcr = Boolean(d.scanDetected && ocrAvailable)
        const stale = d.origin ? generatedStaleness(d, sourcesById) : { stale: false as const }
        const rowBusyLabel = rowTask
          ? `${t(TASK_BUSY_LABEL[rowTask.kind])}${
              rowTask.status && rowTask.status.progress.stepsTotal > 1
                ? ` (${rowTask.status.progress.stepsDone}/${rowTask.status.progress.stepsTotal})`
                : ''
            }`
          : ''
        return (
          <div
            className={`doc-row ${selected.has(d.id) ? 'selected' : ''}`}
            key={d.id}
            onContextMenu={(e) => {
              // Right-click opens the same "⋯" overflow (mirrors the chat list). A failed row
              // has no overflow (just inline Remove / Try again), so leave the native menu.
              if (rowTask || d.status === 'failed') return
              e.preventDefault()
              setMenuOpenId(d.id)
            }}
          >
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
            <Icon name="file" className="doc-row-icon" />
            <div className="doc-row-main">
              <div className="doc-row-title" title={d.originalPath ?? d.title}>
                {d.title}
              </div>
              <div className="doc-row-meta">{metaLine(d)}</div>
              {/* Provenance for a generated document stays a quiet caption, not a badge (Task 2). */}
              {d.origin && <p className="hint doc-row-cap">{provenanceLine(d)}</p>}
              {/* Quiet staleness caption on a generated row (plan §15.3): a warning Badge (icon
                  + word, never color-only) when a source changed/was removed after generation. */}
              {stale.stale && (
                <p className="hint doc-row-cap">
                  <Badge tone="warning" icon="⟳">
                    {t('docs.provenance.staleBadge')}
                  </Badge>{' '}
                  {t(
                    stale.reason === 'source-removed'
                      ? 'docs.provenance.staleRemoved'
                      : 'docs.provenance.staleChanged'
                  )}
                </p>
              )}
              {d.status === 'failed' && d.errorMessage && (
                <Banner tone={d.scanDetected ? 'warning' : 'error'}>
                  {/* error_message is persisted canonical English; the D-L4 display map
                      translates the known constants — unknown strings render as-is. */}
                  {localizeServerCopy(t, d.errorMessage)}
                  {d.scanDetected && (
                    <> {ocrAvailable ? t('docs.scan.ocrOffer') : t('docs.scan.ocrMissing')}</>
                  )}
                </Banner>
              )}
              {d.staleEmbeddings && <Banner tone="warning">{t('docs.stale.banner')}</Banner>}
            </div>
            {/* Trailing cluster (§11.6 refinement): right-aligned, shrink:0 — tag chips, then
                status badges, then Preview + "⋯". The cluster never shrinks and the name column
                (.doc-row-main) takes the flex space, so names breathe and only ellipsize when
                genuinely out of room, while the Preview/⋯ pair lines up in a clean column down
                the list. */}
            <div className="doc-row-trailing">
            {/* Uniform location/project chips (Task 3): a quiet, borderless filled Chip —
                visibly quieter than the bordered Secondary Preview button so a tag never reads
                as clickable. Grouped, visually separate from the status badges. */}
            {chips.length > 0 && (
              <div className="doc-row-chips">
                {chips.map((label) => (
                  <Chip key={label}>{label}</Chip>
                ))}
              </div>
            )}
            {/* Status badge cluster (Task 2 + §11.6 refinement): readiness is the ONLY green
                (success) badge. "Summary" and "Deeply indexed" are NEUTRAL capability badges,
                each with its own glyph — separating "is it ready" (green) from "what's been done
                to it" (neutral). All keep icon + word (1.4.1). */}
            <div className="doc-row-badges">
              <Badge tone={status.tone} icon={status.icon}>
                {status.label}
              </Badge>
              {d.summary && (
                <Badge tone="neutral" icon="≡">
                  {t('docs.meta.summary')}
                </Badge>
              )}
              {d.treeStatus === 'ready' && !d.origin && (
                <Badge tone="neutral" icon="▦" title={t('docs.deepIndex.readyTitle')}>
                  {t('docs.deepIndex.ready')}
                </Badge>
              )}
            </div>
            {/* Inline action + overflow (Task 1). While a task runs on this row, a busy/cancel
                pair takes their place. */}
            <div className="doc-row-actions">
              {rowTask ? (
                <>
                  <Button size="sm" disabled title={t(TASK_BUSY_TITLE[rowTask.kind])}>
                    <Spinner /> {rowBusyLabel}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void cancelActiveDocTask()}
                    title={t(rowTask.kind === 'ocr' ? 'docs.cancelOcrTitle' : 'docs.cancelTaskTitle')}
                  >
                    {t('docs.cancel')}
                  </Button>
                </>
              ) : d.status === 'failed' ? (
                // A failed import never produced extracted text, so Preview is meaningless
                // (§11.6 follow-up). Inline Remove clears the failed entry (reuses the delete
                // handler); Try again re-indexes — offered ONLY when the failure is retryable
                // (a read/parse error), never for an unsupported type. Works in both the
                // All-documents list and the "Failed imports" view (same row markup).
                <>
                  {isRetryableFailure(d.errorMessage) && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      title={t('docs.failed.retryTitle')}
                      onClick={() => void run(`reindex-${d.id}`, () => window.api.reindexDocument(d.id))}
                    >
                      {t('docs.failed.retry')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    title={t('docs.failed.removeTitle')}
                    onClick={() => void run(`delete-${d.id}`, () => window.api.deleteDocument(d.id))}
                  >
                    {t('docs.failed.remove')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={busy !== null || previewLoading || ACTIVE_STATUSES.has(d.status)}
                    onClick={() => void onPreview(d)}
                    title={t('docs.previewTitle')}
                  >
                    {previewLoading ? t('docs.previewBusy') : t('docs.preview')}
                  </Button>
                  <DropdownMenu.Root
                    open={menuOpenId === d.id}
                    onOpenChange={(open) => setMenuOpenId(open ? d.id : null)}
                  >
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="doc-row-menu-btn"
                        disabled={busy !== null}
                        aria-label={t('docs.moreActions', { title: d.title })}
                      >
                        ⋯
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                        {canDocTasks && (
                          <DropdownMenu.Item className="menu-item" disabled={activeTask !== null} onSelect={() => void onSummarize(d)}>
                            {d.summary ? t('docs.summarizeAgain') : t('docs.summarize')}
                          </DropdownMenu.Item>
                        )}
                        {canDocTasks && (
                          <DropdownMenu.Item className="menu-item" disabled={activeTask !== null} onSelect={() => setTranslateDoc(d)}>
                            {t('docs.translate')}
                          </DropdownMenu.Item>
                        )}
                        {/* Contextual: make a detected scan searchable (OCR). */}
                        {showOcr && (
                          <DropdownMenu.Item className="menu-item" disabled={activeTask !== null} onSelect={() => void onMakeSearchable(d)}>
                            {t('docs.makeSearchable')}
                          </DropdownMenu.Item>
                        )}
                        {/* Build deep index — disappears once the doc is deeply indexed (Task 2);
                            C4: a legacy not-fully-chunked doc offers "Re-index for deep index". */}
                        {canDeepIndex && (
                          <DropdownMenu.Item className="menu-item" disabled={activeTask !== null} onSelect={() => void onBuildDeepIndex(d)}>
                            {t(d.fullyChunked === false ? 'docs.deepIndex.reindexFirst' : 'docs.deepIndex.build')}
                          </DropdownMenu.Item>
                        )}
                        <DropdownMenu.Item
                          className="menu-item"
                          disabled={ACTIVE_STATUSES.has(d.status) || activeTask !== null}
                          onSelect={() => void run(`reindex-${d.id}`, () => window.api.reindexDocument(d.id))}
                        >
                          {t('docs.reindex')}
                        </DropdownMenu.Item>
                        {d.origin && (
                          <DropdownMenu.Item
                            className="menu-item"
                            disabled={ACTIVE_STATUSES.has(d.status)}
                            onSelect={() => void onExport(d)}
                          >
                            {t('docs.export')}
                          </DropdownMenu.Item>
                        )}
                        {/* Organize (plan §12.3): add to a project, keep in Library, lifecycle,
                            or remove from the current project. Indexed docs only. */}
                        {d.status === 'indexed' && (
                          <>
                            <DropdownMenu.Separator className="menu-sep" />
                            {activeProjects.length > 0 ? (
                              <DropdownMenu.Item className="menu-item" onSelect={() => setAddToProjectFor([d.id])}>
                                {t('docs.action.moveToProject')}
                              </DropdownMenu.Item>
                            ) : (
                              <DropdownMenu.Item className="menu-item" onSelect={() => setProjectModal({ mode: 'create', name: '' })}>
                                {t('docs.section.newProject')}
                              </DropdownMenu.Item>
                            )}
                            {!(d.collections ?? []).some((c) => c.type === 'library') && (
                              <DropdownMenu.Item className="menu-item" onSelect={() => void onKeepInLibrary(d.id)}>
                                {t('docs.action.addToLibrary')}
                              </DropdownMenu.Item>
                            )}
                            {(d.lifecycle ?? 'permanent') !== 'temporary' ? (
                              <DropdownMenu.Item className="menu-item" onSelect={() => void onSetLifecycle(d.id, 'temporary')}>
                                {t('docs.action.markTemporary')}
                              </DropdownMenu.Item>
                            ) : (
                              <DropdownMenu.Item className="menu-item" onSelect={() => void onSetLifecycle(d.id, 'permanent')}>
                                {t('docs.action.markPermanent')}
                              </DropdownMenu.Item>
                            )}
                            {(d.lifecycle ?? 'permanent') !== 'archived' ? (
                              <DropdownMenu.Item className="menu-item" onSelect={() => void onSetLifecycle(d.id, 'archived')}>
                                {t('docs.action.archive')}
                              </DropdownMenu.Item>
                            ) : (
                              <DropdownMenu.Item className="menu-item" onSelect={() => void onSetLifecycle(d.id, 'permanent')}>
                                {t('docs.action.unarchive')}
                              </DropdownMenu.Item>
                            )}
                            {section.kind === 'project' && (d.collections ?? []).some((c) => c.id === section.id) && (
                              <DropdownMenu.Item className="menu-item" onSelect={() => void onRemoveFromCollection(d.id, section.id)}>
                                {t('docs.action.removeFromProject')}
                              </DropdownMenu.Item>
                            )}
                          </>
                        )}
                        {/* Destructive Delete: separated, danger-styled, behind the ConfirmDialog
                            (icon + word, never color alone). Never an equal-weight surface button. */}
                        <DropdownMenu.Separator className="menu-sep" />
                        <DropdownMenu.Item
                          className="menu-item danger"
                          disabled={ACTIVE_STATUSES.has(d.status)}
                          onSelect={() => setConfirmDelete(d)}
                        >
                          <span aria-hidden="true">🗑</span> {t('docs.delete')}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </>
              )}
            </div>
            </div>{/* /doc-row-trailing */}
          </div>
        )
      })}
      </div>{/* /doc-list */}
        </div>
      </div>{/* /docs-layout */}

      {/* Create / rename a project (plan §12.3). */}
      {projectModal && (
        <Modal
          open
          title={t(projectModal.mode === 'create' ? 'docs.project.createTitle' : 'docs.project.renameTitle')}
          ariaLabel={t(projectModal.mode === 'create' ? 'docs.project.createTitle' : 'docs.project.renameTitle')}
          onClose={() => setProjectModal(null)}
          t={t}
        >
          <input
            type="text"
            className="text-input"
            autoFocus
            value={projectModal.name}
            aria-label={t('docs.project.nameAria')}
            placeholder={t('docs.project.namePlaceholder')}
            onChange={(e) => setProjectModal({ ...projectModal, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSaveProject()
            }}
          />
          <div className="actions" style={{ marginTop: 12 }}>
            <Button variant="primary" disabled={!projectModal.name.trim()} onClick={() => void onSaveProject()}>
              {t(projectModal.mode === 'create' ? 'docs.project.create' : 'docs.project.rename')}
            </Button>
            <Button onClick={() => setProjectModal(null)}>{t('docs.cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* Delete a project — two modes (plan §12.3/C2). */}
      {deleteProject && (
        <Modal
          open
          title={t('docs.project.deleteTitle')}
          ariaLabel={t('docs.project.deleteTitle')}
          onClose={() => setDeleteProject(null)}
          t={t}
        >
          <p className="hint" style={{ marginTop: 0 }}>{t('docs.project.deleteBody')}</p>
          <div className="actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <Button onClick={() => void onDeleteProject('membershipOnly')}>
              {t('docs.project.deleteKeep')}
            </Button>
            <p className="hint" style={{ margin: '0 0 6px' }}>{t('docs.project.deleteKeepHint')}</p>
            <Button onClick={() => void onDeleteProject('withDocuments')}>
              {t('docs.project.deleteWith')}
            </Button>
            <p className="hint" style={{ margin: '0 0 6px' }}>{t('docs.project.deleteWithHint')}</p>
            <Button onClick={() => setDeleteProject(null)}>{t('docs.cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* Add the chosen documents to a project (plan §12.3). */}
      {addToProjectFor && (
        <Modal
          open
          title={t('docs.action.chooseProject')}
          ariaLabel={t('docs.action.chooseProject')}
          onClose={() => setAddToProjectFor(null)}
          t={t}
        >
          <div className="actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            {activeProjects.map((p) => (
              <Button key={p.id} onClick={() => void onAddToProject(p.id)}>
                {p.name}
              </Button>
            ))}
            <Button variant="ghost" onClick={() => setAddToProjectFor(null)}>{t('docs.cancel')}</Button>
          </div>
        </Modal>
      )}

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
        open={confirmBulkDelete}
        title={tCount('docs.bulk.deleteConfirm.title', selected.size)}
        confirmLabel={t('docs.bulk.delete')}
        t={t}
        onConfirm={() => {
          setConfirmBulkDelete(false)
          void onBulkDelete()
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      >
        <p className="hint">{t('docs.bulk.deleteConfirm.body')}</p>
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
          ocr={previewDoc?.ocr ?? null}
          summary={previewDoc?.summary ?? null}
          treeReady={previewDoc?.treeStatus === 'ready'}
          originLine={previewDoc ? provenanceLine(previewDoc) : null}
          regenerateDisabled={busy !== null || activeTask !== null}
          onLoadMore={onPreviewLoadMore}
          onRegenerate={() => {
            setPreview(null)
            if (previewDoc) void onSummarize(previewDoc)
          }}
          onSelectTier={(tier) => {
            setPreview(null)
            if (previewDoc) void onSummarizeTier(previewDoc, tier)
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}

/** The rare, diagnostic smart views — folded behind the Views "More" disclosure so the
 *  common filters stay visible and empty diagnostics don't sit on screen. */
type RareViewKind = 'large' | 'failed' | 'audio' | 'ocr'

/**
 * Left section rail / Documents sub-nav (plan §12.1; regrouped §11.6). Four headed groups in
 * order — **All documents** (default landing, no header) · **Projects** (user-primary, with a
 * "+" add + per-project "⋯") · **Locations** (the system buckets Library / Temporary /
 * Generated / Archived, grouped so they read as one set) · **Views** (the common smart filters
 * always visible, the rare diagnostics behind a remembered "More" disclosure). The whole panel
 * is collapsible (the "«" handle ⇒ `onCollapse`; the list then takes the full width — mirrors
 * the chat ConversationList collapse pattern). Responsive collapse to a horizontal strip still
 * rides on the 760px breakpoint (CSS, plan §12 L4).
 */
function SectionRail({
  section,
  onSelect,
  activeProjects,
  archivedProjects,
  rareCounts,
  busy,
  onCollapse,
  onNewProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  t
}: {
  section: DocSection
  onSelect: (s: DocSection) => void
  collections: Collection[]
  activeProjects: Collection[]
  archivedProjects: Collection[]
  /** Document count per rare view, so an empty diagnostic view is hidden (presentation only). */
  rareCounts: Record<RareViewKind, number>
  busy: boolean
  onCollapse: () => void
  onNewProject: () => void
  onRenameProject: (p: Collection) => void
  onArchiveProject: (p: Collection) => void
  onDeleteProject: (p: Collection) => void
  t: I18n['t']
}): JSX.Element {
  // The "More" disclosure (rare diagnostic views) — a real <button> with aria-expanded,
  // collapsed by default, remembered across sessions (§9 / WCAG 2.2 AA disclosure).
  const [moreOpen, setMoreOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(VIEWS_MORE_KEY) === '1'
    } catch {
      return false
    }
  })
  function toggleMore(): void {
    setMoreOpen((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(VIEWS_MORE_KEY, next ? '1' : '0')
      } catch {
        // best-effort
      }
      return next
    })
  }
  const is = (s: DocSection): boolean =>
    section.kind === s.kind && (s.kind !== 'project' || (s as { id: string }).id === (section as { id: string }).id)
  const railBtn = (s: DocSection, label: string): JSX.Element => (
    <button
      type="button"
      className={`docs-rail-item ${is(s) ? 'active' : ''}`}
      aria-current={is(s) ? 'true' : undefined}
      onClick={() => onSelect(s)}
    >
      {label}
    </button>
  )
  // Rare diagnostic views: shown only when non-empty (empty diagnostics don't clutter the
  // panel) OR when currently selected (never hide the active section out from under the user).
  const rareViews: Array<{ kind: RareViewKind; label: string }> = [
    { kind: 'large', label: t('docs.smart.largeFiles') },
    { kind: 'failed', label: t('docs.smart.failed') },
    { kind: 'audio', label: t('docs.smart.audio') },
    { kind: 'ocr', label: t('docs.smart.ocr') }
  ]
  const visibleRare = rareViews.filter((v) => rareCounts[v.kind] > 0 || section.kind === v.kind)
  return (
    <nav className="docs-rail" aria-label={t('docs.section.heading')}>
      {/* Panel header: a quiet title + the "«" collapse handle (§11.6). */}
      <div className="docs-rail-head">
        <span className="docs-rail-title">{t('docs.section.heading')}</span>
        <button
          type="button"
          className="docs-rail-collapse"
          aria-label={t('docs.rail.hide')}
          title={t('docs.rail.hide')}
          onClick={onCollapse}
        >
          «
        </button>
      </div>

      {/* All documents — the default landing, slightly emphasized; no group header. */}
      {railBtn({ kind: 'all' }, t('docs.section.all'))}

      {/* PROJECTS — user-primary, kept near the top (header + "+"). */}
      <div className="docs-rail-group">
        <div className="docs-rail-group-head">
          <span className="docs-rail-group-label">{t('docs.section.projects')}</span>
          <button
            type="button"
            className="docs-rail-add"
            disabled={busy}
            aria-label={t('docs.section.newProject')}
            title={t('docs.section.newProject')}
            onClick={onNewProject}
          >
            +
          </button>
        </div>
        {activeProjects.length === 0 && <p className="docs-rail-empty hint">{t('docs.section.noProjects')}</p>}
        {activeProjects.map((p) => (
          <div key={p.id} className={`docs-rail-project ${is({ kind: 'project', id: p.id }) ? 'active' : ''}`}>
            <button
              type="button"
              className="docs-rail-item docs-rail-project-name"
              aria-current={is({ kind: 'project', id: p.id }) ? 'true' : undefined}
              onClick={() => onSelect({ kind: 'project', id: p.id })}
            >
              {p.name}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="docs-rail-project-menu" disabled={busy} aria-label={t('docs.project.options')}>
                  ⋯
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onRenameProject(p)}>
                    {t('docs.project.rename')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onArchiveProject(p)}>
                    {t('docs.project.archive')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item danger" onSelect={() => onDeleteProject(p)}>
                    {t('docs.project.delete')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ))}
        {archivedProjects.map((p) => (
          <div key={p.id} className="docs-rail-project archived">
            <button
              type="button"
              className="docs-rail-item docs-rail-project-name"
              title={t('docs.project.archivedNote')}
              onClick={() => onSelect({ kind: 'project', id: p.id })}
            >
              {p.name}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="docs-rail-project-menu" disabled={busy} aria-label={t('docs.project.options')}>
                  ⋯
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onArchiveProject(p)}>
                    {t('docs.project.unarchive')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item danger" onSelect={() => onDeleteProject(p)}>
                    {t('docs.project.delete')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ))}
      </div>
      {/* LOCATIONS — the system buckets, grouped under one header so they read as one set
          (presentation only; the underlying data model / exclusivity is untouched, see the
          location-taxonomy note in BUILD_STATE.md). */}
      <div className="docs-rail-group">
        <div className="docs-rail-group-head">
          <span className="docs-rail-group-label">{t('docs.section.locations')}</span>
        </div>
        {railBtn({ kind: 'library' }, t('docs.section.library'))}
        {railBtn({ kind: 'temporary' }, t('docs.section.temporary'))}
        {railBtn({ kind: 'generated' }, t('docs.section.generated'))}
        {railBtn({ kind: 'archived' }, t('docs.section.archived'))}
      </div>

      {/* VIEWS — query-time smart filters (plan §7.6/§12.1). The common ones stay visible; the
          rare diagnostics fold behind a remembered "More" disclosure (and an empty diagnostic
          view is hidden entirely). */}
      <div className="docs-rail-group">
        <div className="docs-rail-group-head">
          <span className="docs-rail-group-label">{t('docs.smart.heading')}</span>
        </div>
        {railBtn({ kind: 'recent' }, t('docs.smart.recentlyAdded'))}
        {railBtn({ kind: 'unfiled' }, t('docs.smart.unfiled'))}
        {railBtn({ kind: 'needsReindex' }, t('docs.smart.needsReindex'))}
        {visibleRare.length > 0 && (
          <>
            <button
              type="button"
              className="docs-rail-more"
              aria-expanded={moreOpen}
              onClick={toggleMore}
            >
              <span>{t('docs.smart.more')}</span>
              <span className="docs-rail-more-caret" aria-hidden="true">
                {moreOpen ? '▴' : '▾'}
              </span>
            </button>
            {moreOpen && visibleRare.map((v) => railBtn({ kind: v.kind }, v.label))}
          </>
        )}
      </div>
    </nav>
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
  treeReady,
  originLine,
  regenerateDisabled,
  onLoadMore,
  onRegenerate,
  onSelectTier,
  onClose
}: {
  preview: DocumentPreview
  /** Recognition metadata when the text came from local OCR, or null. */
  ocr?: DocumentOcrInfo | null
  summary?: DocumentSummary | null
  /** A whole-document deep index is ready ⇒ the coverage-tier selector is offered. */
  treeReady?: boolean
  /** Provenance line when this is a generated document, or null. */
  originLine?: ReactNode
  regenerateDisabled?: boolean
  /** FE-6: fetch + append the next preview page; offered only when `preview.nextOffset != null`. */
  onLoadMore?: () => Promise<void>
  onRegenerate?: () => void
  /** Re-summarize at a coverage tier (whole-document-analysis §4.5); only when `treeReady`. */
  onSelectTier?: (tier: CoverageTier) => void
  onClose: () => void
}): JSX.Element {
  const { t, tCount, lang } = useT()
  const showToast = useToast()
  // FE-6: guards the "Show more" button while a page is in flight.
  const [loadingMore, setLoadingMore] = useState(false)
  async function loadMore(): Promise<void> {
    if (!onLoadMore || loadingMore) return
    setLoadingMore(true)
    try {
      await onLoadMore()
    } finally {
      setLoadingMore(false)
    }
  }
  // Coverage + source provenance of the current summary (whole-document-analysis §5.1).
  // Read-only, no model call; refreshes whenever the shown summary changes.
  const [cov, setCov] = useState<DocumentCoverage | null>(null)
  useEffect(() => {
    let alive = true
    if (!summary) {
      setCov(null)
      return
    }
    // Tolerant: a partial test bridge (or an older preload) may not provide the method —
    // `Promise.resolve(undefined)` then yields null, never a crash.
    void Promise.resolve(window.api.documentCoverage?.(preview.id))
      .then((c) => {
        if (alive) setCov(c ?? null)
      })
      .catch(() => {
        if (alive) setCov(null)
      })
    return () => {
      alive = false
    }
  }, [preview.id, summary])
  // Copy the raw summary Markdown to the OS clipboard (via MAIN — the file://-loaded
  // renderer can't use navigator.clipboard). Confirmation is a transient toast.
  function onCopySummary(): void {
    if (!summary) return
    void Promise.resolve(window.api.copyToClipboard?.(summary.text))
      .then((ok) => showToast(ok ? t('docs.previewModal.copied') : t('docs.previewModal.copyFailed')))
      .catch(() => showToast(t('docs.previewModal.copyFailed')))
  }
  // Save the summary to a user-chosen Markdown file (dialog + fs run in MAIN). A
  // cancelled dialog resolves null and shows no toast.
  async function onSaveSummary(): Promise<void> {
    if (!summary) return
    try {
      const path = await window.api.exportSummary?.(preview.id)
      if (path) showToast(t('docs.previewModal.savedTo', { path }))
    } catch {
      // Export is cancellable from the OS dialog; a failure simply shows no toast.
    }
  }
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
      {/* Single scroll region (audit: a long summary sat above the scroll box and overflowed
          with no scrollbar). Summary + extracted text now scroll together. */}
      <div className="modal-body">
        {summary && (
          <details className="doc-summary" open>
            <summary>{t('docs.previewModal.summary')}</summary>
            <div className="doc-summary-body">
              <p className="hint" style={{ margin: 0 }}>
                {summaryAttribution(summary, t, lang)}
              </p>
              {/* Coverage meter (whole-document-analysis §5.2): states breadth (whole document
                  vs the beginning) AND depth (tier) honestly — augments the truncated banner. */}
              {cov && <CoverageMeter coverage={cov.coverage} />}
              {summary.truncated && (
                <Banner tone="warning">{t('docs.previewModal.truncated')}</Banner>
              )}
              {/* Coverage-tier selector — only with a ready deep index (Tier 2/3 read it). */}
              {treeReady && onSelectTier && (
                <TierMenu
                  value={summary.tier ?? 1}
                  disabled={regenerateDisabled}
                  onChange={onSelectTier}
                />
              )}
              {/* Render the summary as Markdown (local models emit `**bold**`/lists/headings —
                  the raw asterisks read as broken). Reuses the chat answer styling + sanitizer. */}
              <div className="msg-content md">
                <AssistantMarkdown text={summary.text} />
              </div>
              {/* Source provenance behind a deep-index summary — the leaf SOURCE chunks (M2:
                  never node summaries). Reuses the chat sources disclosure. */}
              {cov && cov.provenance.length > 0 && (
                <SourcesDisclosure citations={cov.provenance} />
              )}
              <div className="actions" style={{ marginTop: 4 }}>
                <Button size="sm" onClick={onCopySummary}>
                  {t('docs.previewModal.copy')}
                </Button>
                <Button size="sm" onClick={() => void onSaveSummary()}>
                  {t('docs.previewModal.save')}
                </Button>
                {onRegenerate && (
                  <Button size="sm" disabled={regenerateDisabled} onClick={onRegenerate}>
                    {t('docs.previewModal.regenerate')}
                  </Button>
                )}
              </div>
            </div>
          </details>
        )}
        {preview.segments.length === 0 && (
          <p className="hint">{t('docs.previewModal.noText')}</p>
        )}
        {/* The extracted text is collapsed behind a disclosure: for a large document the
            per-page list runs very long and buries the summary above. Open by default only
            when there's no summary, so the preview never looks empty. Markdown documents
            (e.g. machine-translated .md) render formatted — the raw `**bold**`/lists read
            as broken otherwise — reusing the chat answer styling + sanitizer. */}
        {preview.segments.length > 0 &&
          (() => {
            const isMarkdown = (preview.mimeType ?? '').includes('markdown')
            return (
              <details className="doc-summary doc-rawtext" open={!summary}>
                <summary>{t('docs.previewModal.documentText')}</summary>
                <div className="doc-summary-body">
                  {preview.segments.map((s, i) => (
                    <div key={i} className="preview-segment">
                      {(s.pageNumber != null || s.sectionLabel) && (
                        <div className="preview-label">
                          {s.pageNumber != null
                            ? t('docs.previewModal.page', { page: s.pageNumber })
                            : s.sectionLabel}
                        </div>
                      )}
                      {isMarkdown ? (
                        <div className="msg-content md">
                          <AssistantMarkdown text={s.text} />
                        </div>
                      ) : (
                        <div className="preview-text">{s.text}</div>
                      )}
                    </div>
                  ))}
                  {/* FE-6: the preview arrives a page at a time; reveal the rest on demand
                      instead of mounting a whole large document at once. */}
                  {preview.nextOffset != null && (
                    <div className="preview-more">
                      <Button size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                        {loadingMore
                          ? t('docs.previewModal.loadingMore')
                          : t('docs.previewModal.showMore')}
                      </Button>
                      {preview.totalSegments != null && (
                        <span className="hint">
                          {t('docs.previewModal.segmentProgress', {
                            shown: preview.segments.length,
                            total: preview.totalSegments
                          })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </details>
            )
          })()}
      </div>
    </Modal>
  )
}
