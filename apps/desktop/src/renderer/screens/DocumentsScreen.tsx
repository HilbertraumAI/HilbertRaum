import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Badge, Banner, Button, ConfirmDialog, CoverageMeter, EmptyState, ErrorBanner, Modal, Progress, Spinner, TierMenu, type BadgeTone } from '../components'
import { SourcesDisclosure } from '../chat/SourcesDisclosure'
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
  FilingSuggestion,
  FilingSuggestionResult,
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
  ocr: 'docs.task.ocrBusy',
  tree: 'docs.task.treeBusy'
}
const TASK_BUSY_TITLE: Record<DocTaskKind, MessageKey> = {
  summary: 'docs.task.summaryBusyTitle',
  translation: 'docs.task.translationBusyTitle',
  compare: 'docs.task.compareBusyTitle',
  ocr: 'docs.task.ocrBusyTitle',
  tree: 'docs.task.treeBusyTitle'
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
  // Rule-based filing suggestions (plan §20 Phase F): the unfiled-doc suggestions from the
  // read-only IPC + the user's persisted dismissals (AppSettings). A suggestion is inert — it
  // only files on an explicit Apply; Dismiss hides the chip and sticks across a restart.
  const [suggestions, setSuggestions] = useState<FilingSuggestionResult[]>([])
  const [dismissedSuggestions, setDismissedSuggestions] = useState<ReadonlySet<string>>(new Set())
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

  // Filing suggestions + the persisted dismissal set (plan §20 Phase F). Tolerant: a partial
  // test bridge / a read failure leaves the chips absent, never an error.
  const refreshSuggestions = useCallback(async (): Promise<void> => {
    try {
      setSuggestions((await window.api.filingSuggestions?.()) ?? [])
    } catch {
      setSuggestions([])
    }
    try {
      const s = await window.api.getSettings?.()
      setDismissedSuggestions(new Set(s?.dismissedFilingSuggestions ?? []))
    } catch {
      /* keep the prior dismissal set */
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.api.listDocuments()
    setDocs(next)
    void refreshCollections()
    void refreshSuggestions()
    // Drop selected ids that no longer exist or are no longer indexed.
    setSelected((prev) => {
      const valid = new Set(next.filter((d) => d.status === 'indexed').map((d) => d.id))
      const kept = [...prev].filter((id) => valid.has(id))
      return kept.length === prev.size ? prev : new Set(kept)
    })
  }, [refreshCollections, refreshSuggestions])

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

  /** A source document's title for a provenance line (the source may be gone). */
  function titleOf(id: string): string {
    return docs?.find((x) => x.id === id)?.title ?? t('docs.removedDocFallback')
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

  const anyActive = docs?.some((d) => ACTIVE_STATUSES.has(d.status)) ?? false
  const staleDocs = docs?.filter((d) => d.staleEmbeddings) ?? []
  const empty = docs != null && docs.length === 0

  // ---- Document-organization: section rail filtering + collection/project actions ----
  const projects = collections.filter((c) => c.type === 'project')
  const activeProjects = projects.filter((c) => c.archivedAt == null)
  const libraryCollection = collections.find((c) => c.type === 'library') ?? null
  const temporaryCollection = collections.find((c) => c.type === 'temporary') ?? null

  /** Whether a document belongs in the current (non-project) section (plan §12.1). */
  function inSection(d: DocumentInfo): boolean {
    const lifecycle = d.lifecycle ?? 'permanent'
    switch (section.kind) {
      case 'temporary':
        return lifecycle === 'temporary' || (d.collections ?? []).some((c) => c.type === 'temporary')
      case 'library':
        return (d.collections ?? []).some((c) => c.type === 'library')
      // Phase-E query-time smart views (plan §7.6): the shared predicate keeps the rail
      // in lockstep with the docs:list filter. ('generated'/'archived' route through it too.)
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
        return true // 'all' + 'recent' (ordered in visibleDocs) + 'project' (handled below)
    }
  }
  // Source lookup for the generated-staleness derivation (plan §15.3) — pure, off the
  // already-listed fields; no extra read, no hot-path write.
  const sourcesById = new Map((docs ?? []).map((d) => [d.id, d]))
  // Top filing suggestion per document (plan §20 Phase F) — the renderer surfaces one quiet
  // chip per row; the rest of the ranked list stays available for a later affordance.
  const topSuggestionByDoc = new Map(suggestions.map((s) => [s.documentId, s.suggestions[0]]))
  const sectioned: DocumentInfo[] =
    docs == null
      ? []
      : section.kind === 'project'
        ? docs.filter((d) => (d.collections ?? []).some((c) => c.id === section.id))
        : docs.filter(inSection)
  // "Recently added" is an ordering, not a membership predicate (plan §7.6 — no new column).
  const visibleDocs: DocumentInfo[] =
    section.kind === 'recent'
      ? [...sectioned].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      : sectioned

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

  // ---- Filing suggestions: Apply (never auto-file) + Dismiss (plan §20 Phase F) ----------
  // Apply reuses the existing membership path — existing project ⇒ addToCollection; new
  // project ⇒ createCollection + addToCollection — then the refresh drops the now-filed doc
  // out of Unfiled and clears its chip. A suggestion is NEVER applied without this click.
  async function onApplySuggestion(documentId: string, sug: FilingSuggestion): Promise<void> {
    await runOrg('suggest', async () => {
      if (sug.target.kind === 'existingProject') {
        await window.api.addToCollection([documentId], sug.target.collectionId)
      } else {
        const created = await window.api.createCollection(sug.target.suggestedName)
        await window.api.addToCollection([documentId], created.id)
      }
    })
  }

  // Dismiss: hide the chip and persist the dismissal in AppSettings (NOT a new column) so it
  // sticks across a restart. Optimistic + tolerant — a failed persist still hides it this
  // session.
  async function onDismissSuggestion(documentId: string): Promise<void> {
    const next = new Set(dismissedSuggestions)
    next.add(documentId)
    setDismissedSuggestions(next)
    try {
      await window.api.updateSettings?.({ dismissedFilingSuggestions: [...next] })
    } catch {
      /* stays hidden this session even if the persist failed */
    }
  }

  /** The display name of a suggestion's target project (existing ⇒ resolved; new ⇒ proposed).
   *  Empty when an existing target no longer exists (then the chip is suppressed). */
  function suggestionTargetName(sug: FilingSuggestion): string {
    const target = sug.target
    if (target.kind === 'newProject') return target.suggestedName
    return collections.find((c) => c.id === target.collectionId)?.name ?? ''
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

      <div className="docs-layout">
        <SectionRail
          section={section}
          onSelect={setSection}
          collections={collections}
          activeProjects={activeProjects}
          archivedProjects={projects.filter((c) => c.archivedAt != null)}
          busy={busy !== null}
          onNewProject={() => setProjectModal({ mode: 'create', name: '' })}
          onRenameProject={(p) => setProjectModal({ mode: 'rename', id: p.id, name: p.name })}
          onArchiveProject={(p) => void onArchiveProject(p)}
          onDeleteProject={(p) => setDeleteProject(p)}
          t={t}
        />
        <div className="docs-main">

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
          {/* Bulk organization actions on the current selection (plan §12.3). */}
          {selected.size > 0 && activeProjects.length > 0 && (
            <Button size="sm" disabled={busy !== null} onClick={() => setAddToProjectFor([...selected])}>
              {t('docs.action.moveToProject')}
            </Button>
          )}
          {selected.size > 0 && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void runOrg('org', () =>
                  window.api.setDocumentLifecycle([...selected], 'temporary')
                )
              }
            >
              {t('docs.action.markTemporary')}
            </Button>
          )}
          {selected.size > 0 && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void runOrg('org', () =>
                  window.api.setDocumentLifecycle([...selected], 'archived')
                )
              }
            >
              {t('docs.action.archive')}
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

      {docs != null && docs.length > 0 && visibleDocs.length === 0 && (
        <p className="hint">{t('docs.empty.section')}</p>
      )}

      {visibleDocs.map((d) => (
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
            {/* Lifecycle pill (Temporary / Archived) when not the default 'permanent'. */}
            {d.lifecycle === 'temporary' && <Badge tone="accent">{t('docs.lifecycle.temporary')}</Badge>}
            {d.lifecycle === 'archived' && <Badge tone="neutral">{t('docs.lifecycle.archived')}</Badge>}
            <Badge tone={badgeFor(d, t).tone} icon={badgeFor(d, t).icon}>
              {badgeFor(d, t).label}
            </Badge>
          </div>
          {/* Collection/project membership chips (plan §12.2). */}
          {(d.collections ?? []).length > 0 && (
            <div className="doc-chips">
              {(d.collections ?? []).map((c) => (
                <span className="doc-chip" key={c.id}>
                  {c.type === 'library'
                    ? t('docs.chip.library')
                    : c.type === 'temporary'
                      ? t('docs.chip.temporary')
                      : c.name}
                </span>
              ))}
            </div>
          )}
          {/* Quiet, dismissible filing suggestion (plan §20 Phase F): a calm chip on an
              unfiled doc — "Suggested project: Tax 2025 — Apply?". Apply files via the existing
              membership path; nothing is ever filed without that click. Never shown once
              dismissed (persisted) or when the target project has since vanished. */}
          {!dismissedSuggestions.has(d.id) &&
            (() => {
              const sug = topSuggestionByDoc.get(d.id)
              if (!sug) return null
              const name = suggestionTargetName(sug)
              if (!name) return null
              // a11y (UX-1): group the chip and tie the rationale to Apply via
              // aria-describedby, so a screen-reader user tabbing to Apply hears WHY the
              // suggestion was made, not just its title. Ids are per-doc-row unique.
              const textId = `suggest-text-${d.id}`
              const reasonId = `suggest-reason-${d.id}`
              return (
                <div className="doc-suggest" role="group" aria-labelledby={textId}>
                  <span className="doc-suggest-text" id={textId}>
                    {t(sug.target.kind === 'newProject' ? 'docs.suggest.chipNew' : 'docs.suggest.chipExisting', {
                      name
                    })}
                  </span>
                  <span className="doc-suggest-reason hint" id={reasonId}>
                    {t(sug.reasonKey, sug.reasonParams)}
                  </span>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    title={t('docs.suggest.applyTitle', { name })}
                    aria-describedby={reasonId}
                    onClick={() => void onApplySuggestion(d.id, sug)}
                  >
                    {t('docs.suggest.apply')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    title={t('docs.suggest.dismissTitle')}
                    onClick={() => void onDismissSuggestion(d.id)}
                  >
                    {t('docs.suggest.dismiss')}
                  </Button>
                </div>
              )
            })()}
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
          {/* Quiet staleness indicator on a generated row (plan §15.3): a Badge (icon +
              word, never color-only) plus copy when a source changed/was removed after this
              output was generated. Re-running the task stays the only fix — no auto-update. */}
          {d.origin &&
            (() => {
              const stale = generatedStaleness(d, sourcesById)
              if (!stale.stale) return null
              return (
                <p className="hint" style={{ margin: '2px 0 0' }}>
                  <Badge tone="warning" icon="⟳">
                    {t('docs.provenance.staleBadge')}
                  </Badge>{' '}
                  {t(
                    stale.reason === 'source-removed'
                      ? 'docs.provenance.staleRemoved'
                      : 'docs.provenance.staleChanged'
                  )}
                </p>
              )
            })()}
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
            {/* Deep index (whole-document-analysis §5.2): "Deeply indexed" once a
                whole-document deep index is ready, else the build action. A building/pending
                index surfaces through the busy block above, so the control is hidden then.
                Generated work-products are excluded (no corpus deep index). C4: a not-fully-
                chunked legacy doc offers "Re-index for deep index", never a dead 100% button. */}
            {d.status === 'indexed' &&
              d.chunkCount > 0 &&
              !d.origin &&
              !(
                activeTask &&
                activeTask.documentIds.includes(d.id) &&
                !isDocTaskTerminal(activeTask.status)
              ) &&
              (d.treeStatus === 'ready' ? (
                <Badge tone="success" icon="✓" title={t('docs.deepIndex.readyTitle')}>
                  {t('docs.deepIndex.ready')}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  disabled={busy !== null || activeTask !== null}
                  onClick={() => void onBuildDeepIndex(d)}
                  title={t(
                    d.fullyChunked === false
                      ? 'docs.deepIndex.reindexFirstTitle'
                      : 'docs.deepIndex.buildTitle'
                  )}
                >
                  {t(d.fullyChunked === false ? 'docs.deepIndex.reindexFirst' : 'docs.deepIndex.build')}
                </Button>
              ))}
            {/* Organize menu (plan §12.3): add to a project, keep in Library, change
                lifecycle, or remove from the current project. Indexed docs only. */}
            {d.status === 'indexed' && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button size="sm" disabled={busy !== null} title={t('docs.action.addToProject')}>
                    {t('docs.action.addToProject')}
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
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
                      <DropdownMenu.Item
                        className="menu-item"
                        onSelect={() => void onRemoveFromCollection(d.id, section.id)}
                      >
                        {t('docs.action.removeFromProject')}
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
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
          treeReady={docs?.find((x) => x.id === preview.id)?.treeStatus === 'ready'}
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
          onSelectTier={(tier) => {
            const d = docs?.find((x) => x.id === preview.id)
            setPreview(null)
            if (d) void onSummarizeTier(d, tier)
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}

/**
 * Left section rail (plan §12.1): the saved-filter navigation — Library, each Project,
 * Temporary, Generated, Archived, All. Responsive collapse to a horizontal strip rides on
 * the existing 760px breakpoint (CSS, plan §12 L4). Project rows carry inline manage actions.
 */
function SectionRail({
  section,
  onSelect,
  activeProjects,
  archivedProjects,
  busy,
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
  busy: boolean
  onNewProject: () => void
  onRenameProject: (p: Collection) => void
  onArchiveProject: (p: Collection) => void
  onDeleteProject: (p: Collection) => void
  t: I18n['t']
}): JSX.Element {
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
  return (
    <nav className="docs-rail" aria-label={t('docs.section.heading')}>
      {railBtn({ kind: 'library' }, t('docs.section.library'))}
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
      {railBtn({ kind: 'temporary' }, t('docs.section.temporary'))}
      {railBtn({ kind: 'generated' }, t('docs.section.generated'))}
      {railBtn({ kind: 'archived' }, t('docs.section.archived'))}
      {railBtn({ kind: 'all' }, t('docs.section.all'))}
      {/* Phase-E smart views (plan §7.6/§12.1): query-time filters, not stored collections.
          Reuses the projects-group layout so the existing 760px reflow applies (L4). */}
      <div className="docs-rail-group">
        <div className="docs-rail-group-head">
          <span className="docs-rail-group-label">{t('docs.smart.heading')}</span>
        </div>
        {railBtn({ kind: 'recent' }, t('docs.smart.recentlyAdded'))}
        {railBtn({ kind: 'unfiled' }, t('docs.smart.unfiled'))}
        {railBtn({ kind: 'needsReindex' }, t('docs.smart.needsReindex'))}
        {railBtn({ kind: 'large' }, t('docs.smart.largeFiles'))}
        {railBtn({ kind: 'failed' }, t('docs.smart.failed'))}
        {railBtn({ kind: 'audio' }, t('docs.smart.audio'))}
        {railBtn({ kind: 'ocr' }, t('docs.smart.ocr'))}
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
  onRegenerate?: () => void
  /** Re-summarize at a coverage tier (whole-document-analysis §4.5); only when `treeReady`. */
  onSelectTier?: (tier: CoverageTier) => void
  onClose: () => void
}): JSX.Element {
  const { t, tCount, lang } = useT()
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
            <div className="preview-text">{summary.text}</div>
            {/* Source provenance behind a deep-index summary — the leaf SOURCE chunks (M2:
                never node summaries). Reuses the chat sources disclosure. */}
            {cov && cov.provenance.length > 0 && (
              <SourcesDisclosure citations={cov.provenance} />
            )}
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
