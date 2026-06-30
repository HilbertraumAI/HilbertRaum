import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
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
  TranslationSourceLang,
  TranslationTargetLang
} from '@shared/types'
import {
  generatedStaleness,
  matchesSmartView,
  provenanceView,
  TRANSLATION_LANGUAGE_CODES,
  TRANSLATION_NATIVE_NAMES
} from '@shared/types'
import {
  acknowledgeDocTask,
  cancelActiveDocTask,
  getActiveDocTask,
  isDocTaskTerminal,
  startTask,
  subscribeDocTask,
  type ActiveDocTask
} from '../lib/doctasks'
import { friendlyIpcError } from '../lib/errors'
import { localizeServerCopy, unsupportedTypeExt } from '../lib/displayMap'
import { useEventCallback } from '../lib/useEventCallback'
import { useT, type I18n } from '../i18n'
import { en, type MessageKey, type UiLanguage } from '@shared/i18n'
// DX-3 split (full-audit-2026-06-29 follow-up Phase 8): the per-row component, the section rail,
// the preview modal, and the pure formatters now live in sibling `./documents/*` files —
// relocation only, behavior unchanged. Re-exported below so the existing test import sites
// (`friendlyMimeLabel` / `isRetryableFailure` / `__docRowRenderCounts` / the localStorage keys)
// keep resolving against `DocumentsScreen`.
import { DocRow } from './documents/DocRow'
import { SectionRail } from './documents/SectionRail'
import { PreviewModal } from './documents/PreviewModal'
import {
  ACTIVE_STATUSES,
  DOC_ROW_ESTIMATED_HEIGHT,
  DOC_ROW_OVERSCAN,
  formatSize,
  provenanceLine
} from './documents/format'
import { RAIL_COLLAPSED_KEY, type DocSection, type RareViewKind } from './documents/types'

export { friendlyMimeLabel, isRetryableFailure, __docRowRenderCounts } from './documents/format'
export { RAIL_COLLAPSED_KEY, VIEWS_MORE_KEY } from './documents/types'

// Documents screen (spec §7.7). Import files or a folder via the OS picker
// (opened in the main process), watch each file move through the ingestion statuses, and
// delete / re-index documents. Import runs async in the backend; this screen polls
// getImportJob + listDocuments while a job is in flight (async-with-polling).

/**
 * Total picked audio bytes above which the import asks first: the
 * recording is copied onto the drive (encrypted on encrypted workspaces) AND fully
 * transcribed on the CPU — real space + real minutes the user should consciously accept.
 */
const LARGE_AUDIO_CONFIRM_BYTES = 50 * 1024 * 1024

// FE-6: how many preview segments to fetch per page (first page + each "Show more").
const PREVIEW_PAGE_SIZE = 50

interface Props {
  /** "Ask these documents" (spec §10.4): open Chat scoped to the selection. */
  onAskSelected?: (documentIds: string[]) => void
  /** Deep links out of this screen (TG-3: the translate model-missing state → 'models'). */
  onNavigate?: (target: string) => void
}

/** The translate modal's language pair, remembered session-local (deliberately not persisted). */
let lastTranslateChoice: {
  sourceLang: TranslationSourceLang
  targetLang: TranslationTargetLang
} | null = null

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

export function DocumentsScreen({ onAskSelected, onNavigate }: Props = {}): JSX.Element {
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
    /** D1 picker capability token to carry through the confirm dialog into the actual import. */
    token: string
    audioFileCount: number
    audioBytes: number
  } | null>(null)
  // "Translate" language choice: the row button opens this small modal. The source+target
  // pair starts from the session's last choice (else a UI-language-aware default) — TG-3
  // widened the closed de/en pair to the curated 10-language set.
  const [translateDoc, setTranslateDoc] = useState<DocumentInfo | null>(null)
  const [translateChoice, setTranslateChoice] = useState<{
    sourceLang: TranslationSourceLang
    targetLang: TranslationTargetLang
  }>(
    () =>
      lastTranslateChoice ??
      (lang === 'de'
        ? { sourceLang: 'en', targetLang: 'de' }
        : { sourceLang: 'de', targetLang: 'en' })
  )
  // Translation availability (availability-driven, no settings key): the TranslateGemma
  // sidecar resolves at app startup, so this gates "Translate" the way `ocrAvailable`
  // gates OCR — read once with it below.
  const [translationAvailable, setTranslationAvailable] = useState(false)
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
  // The pending target carries WHICH set is being re-indexed (stale embeddings vs failed
  // imports) so the confirm copy and snapshot match the button that opened it; null = closed.
  const [confirmReindexAll, setConfirmReindexAll] = useState<{
    kind: 'stale' | 'failed'
    docs: DocumentInfo[]
  } | null>(null)
  const [reindexProgress, setReindexProgress] = useState<{ done: number; total: number } | null>(
    null
  )
  // Bulk delete from the selection toolbar (§11.6) — behind a ConfirmDialog like single delete.
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // One controlled per-row "⋯" menu so right-click opens the same overflow (mirrors the
  // chat ConversationList pattern). Holds the open row id, or null.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Separate interval for the bulk re-index poll so it never clobbers the import poll above.
  const reindexPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Mounted flag (audit FE-4): the import poll's in-flight `getImportJob`/`refresh` can resolve
  // AFTER the interval is cleared on unmount; clearing the interval doesn't abort that tick's
  // promise, so guard every setState behind this flag.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
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
    if (!mountedRef.current) return // unmounted while the list was loading (FE-4)
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
        const status = await window.api.getAppStatus()
        setOcrAvailable(status.ocrAvailable)
        setTranslationAvailable(status.translationAvailable)
      } catch {
        // No status (partial test bridge) → keep the safe defaults: no OCR offer, no
        // Translate (the install hint shows instead).
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
          // The interval may have been cleared (unmount) while this tick was awaiting — drop
          // the late result instead of setState-ing on an unmounted component (audit FE-4).
          if (!mountedRef.current) return
          const settled = job.completed + job.failed
          const transitioned = settled !== lastSettled
          lastSettled = settled
          if (transitioned || job.done) await refresh()
          if (job.done) {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            if (mountedRef.current) setBusy(null)
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          if (!mountedRef.current) return
          setBusy(null)
          setError(friendlyIpcError(e))
        }
      }, 400)
    },
    [refresh]
  )

  // Poll the MAIN-owned bulk re-index job until it settles. Mirrors `watchJob`: a 400 ms tick reads
  // the small `getReindexAllJob` status, refreshes the full list on a count transition + at the end,
  // and drives the determinate progress bar. Because the job lives in main, this re-attaches cleanly
  // after navigating away and back (the mount effect below restarts it) — the bar no longer vanishes.
  const watchReindex = useCallback((): void => {
    if (reindexPollRef.current) clearInterval(reindexPollRef.current)
    let lastSettled = -1
    reindexPollRef.current = setInterval(async () => {
      try {
        const job = await window.api.getReindexAllJob?.()
        if (!mountedRef.current) return
        if (!job) {
          // No job (cleared/expired) — stop and reset the UI.
          if (reindexPollRef.current) clearInterval(reindexPollRef.current)
          reindexPollRef.current = null
          setBusy(null)
          setReindexProgress(null)
          return
        }
        setReindexProgress({ done: job.completed + job.failed, total: job.total })
        const settled = job.completed + job.failed
        const transitioned = settled !== lastSettled
        lastSettled = settled
        if (transitioned || job.done) await refresh()
        if (job.done) {
          if (reindexPollRef.current) clearInterval(reindexPollRef.current)
          reindexPollRef.current = null
          if (mountedRef.current) {
            setBusy(null)
            setReindexProgress(null)
          }
        }
      } catch (e) {
        if (reindexPollRef.current) clearInterval(reindexPollRef.current)
        reindexPollRef.current = null
        if (!mountedRef.current) return
        setBusy(null)
        setReindexProgress(null)
        setError(friendlyIpcError(e))
      }
    }, 400)
  }, [refresh])

  // Recover a bulk re-index already running in main when the screen (re)mounts: this is what keeps
  // the progress bar alive across navigation. Also clears the poll on unmount.
  useEffect(() => {
    void (async () => {
      try {
        const job = await window.api.getReindexAllJob?.()
        if (job && !job.done && mountedRef.current) {
          setBusy('reindex-all')
          setReindexProgress({ done: job.completed + job.failed, total: job.total })
          watchReindex()
        }
      } catch {
        // No bridge / locked — nothing to recover.
      }
    })()
    return () => {
      if (reindexPollRef.current) clearInterval(reindexPollRef.current)
    }
  }, [watchReindex])

  // `token` (D1) is the picker capability from `pickDocuments`; main imports exactly what was
  // picked and ignores the `paths` we pass (kept only so an old test/caller still type-checks).
  async function startImport(paths: string[], token: string): Promise<void> {
    try {
      setBusy('import')
      const job = await window.api.importDocuments(paths, { pickerToken: token })
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
      const { token, paths } = await window.api.pickDocuments(mode)
      if (paths.length === 0) return
      // Size-aware audio gate: large recordings cost drive space
      // (the workspace copy) and real transcription time — ask first.
      const pre = await window.api.importPreflight(paths)
      if (pre.audioBytes >= LARGE_AUDIO_CONFIRM_BYTES) {
        setConfirmAudio({ paths, token, audioFileCount: pre.audioFileCount, audioBytes: pre.audioBytes })
        return
      }
      await startImport(paths, token)
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

  async function onTranslate(
    d: DocumentInfo,
    sourceLang: TranslationSourceLang,
    targetLang: TranslationTargetLang
  ): Promise<void> {
    setTranslateDoc(null)
    setError(null)
    setPreview(null)
    lastTranslateChoice = { sourceLang, targetLang }
    try {
      await startTask('translation', d.id, { sourceLang, targetLang })
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

  // Derived collections (plan §12) — memoized so the render body (re-run on every 400 ms import
  // poll + every unrelated state change: menu/hover/modal) doesn't re-filter the whole list each
  // time (FE-2). Keyed only on the inputs each derivation actually reads.
  const anyActive = useMemo(() => docs?.some((d) => ACTIVE_STATUSES.has(d.status)) ?? false, [docs])
  const staleDocs = useMemo(() => docs?.filter((d) => d.staleEmbeddings) ?? [], [docs])
  // The 'failed' smart view (status === 'failed'): drives the "Retry all" action shown on that tab.
  const failedDocs = useMemo(() => docs?.filter((d) => d.status === 'failed') ?? [], [docs])
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

  // PERF-2 (= PERF-5 Part B; full-audit-2026-06-29 follow-up, Phase 4) — window the documents list
  // so the live DOM (and the per-row Radix `DropdownMenu.Root` state machines) stop growing linearly
  // with library size. The screen scrolls as a whole inside the app's `.content` container (NOT an
  // inner pane), so we virtualize AGAINST that existing scroll element with a `scrollMargin` for the
  // header/hints above the list — additive, the full-screen scroll behavior is unchanged.
  //
  // GATING: windowing only engages once a real, laid-out scroll viewport is resolved
  // (`clientHeight > 0`). With no `.content` ancestor or a zero-height viewport — a unit test
  // rendering the screen standalone under jsdom, or first paint before layout — there is nothing to
  // virtualize, so we fall back to rendering every row (byte-identical to the pre-PERF-2 list). This
  // keeps the existing DocumentsScreen test corpus on the un-windowed path and is a truthful guard,
  // not a test-env sniff (a 0px viewport genuinely can't be windowed). KNOWN TRADEOFF: find-in-page
  // (Ctrl+F) can't match a row that isn't currently rendered — acceptable for a name-scannable
  // library list (documented in docs/known-limitations.md).
  const docListRef = useRef<HTMLDivElement | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)

  // Resolve the screen scroll container once mounted.
  useLayoutEffect(() => {
    setScrollEl((docListRef.current?.closest('.content') as HTMLElement | null) ?? null)
  }, [])

  // Keep the list's start offset within the scroll container current (content above it — hints,
  // banners — can change height on section switch / doc-count change / window resize).
  useLayoutEffect(() => {
    const list = docListRef.current
    if (!list || !scrollEl) return
    const recompute = (): void => {
      const m =
        list.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      setScrollMargin((prev) => (Math.abs(prev - m) > 0.5 ? Math.max(0, m) : prev))
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(scrollEl)
    ro.observe(list)
    window.addEventListener('resize', recompute)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', recompute)
    }
  }, [scrollEl, visibleDocs.length, section])

  const rowVirtualizer = useVirtualizer({
    count: visibleDocs.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => DOC_ROW_ESTIMATED_HEIGHT,
    overscan: DOC_ROW_OVERSCAN,
    scrollMargin,
    // Stable identity per document so a list reorder/filter doesn't desync measured heights.
    getItemKey: (index) => visibleDocs[index]?.id ?? index
  })
  const windowed = scrollEl != null && scrollEl.clientHeight > 0
  const virtualRows = rowVirtualizer.getVirtualItems()

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

  // Re-index a set of documents — the loop runs in MAIN (startReindexAll) so its determinate
  // progress survives navigating away from this screen; here we just start it and poll via
  // watchReindex. Confirmed first (M-U6) because it is multi-minute CPU work. Used by both
  // "Re-index all" (stale embeddings) and the failed-tab "Retry all".
  function onReindexAll(targets: DocumentInfo[]): void {
    setBusy('reindex-all')
    setError(null)
    setReindexProgress({ done: 0, total: targets.length })
    void (async () => {
      try {
        // Main owns the loop now (it survives navigation); we just kick it off and poll.
        await window.api.startReindexAll(targets.map((d) => d.id))
        watchReindex()
      } catch (e) {
        setBusy(null)
        setReindexProgress(null)
        setError(friendlyIpcError(e))
      }
    })()
  }

  // Stable row-handler identities for the memoized DocRow (perf audit PERF-5). The latest-ref
  // wrappers keep each handler's identity constant across the 400 ms task-progress ticks (which
  // re-run this body via the `activeTask` store) and unrelated state changes, so a row's React.memo
  // holds unless ITS OWN props change. useState setters (setMenuOpenId/setTranslateDoc/
  // setAddToProjectFor/setProjectModal/setConfirmDelete) and the imported cancelActiveDocTask are
  // already stable, so they pass through directly. The impl functions above are hoisted, so
  // referencing them here is fine.
  const handleToggleSelected = useEventCallback(toggleSelected)
  const handlePreview = useEventCallback(onPreview)
  const handleRun = useEventCallback(run)
  const handleSummarize = useEventCallback(onSummarize)
  const handleMakeSearchable = useEventCallback(onMakeSearchable)
  const handleBuildDeepIndex = useEventCallback(onBuildDeepIndex)
  const handleExport = useEventCallback(onExport)
  const handleKeepInLibrary = useEventCallback(onKeepInLibrary)
  const handleSetLifecycle = useEventCallback(onSetLifecycle)
  const handleRemoveFromCollection = useEventCallback(onRemoveFromCollection)
  // The translate model-missing deep link (TG-3): the DocRow install item → AI Model screen.
  const handleOpenModels = useEventCallback(() => onNavigate?.('models'))

  // One row's <DocRow> — shared by the windowed and the un-windowed (fallback) list paths (PERF-2),
  // so the props wiring stays in exactly one place. The data SOURCE is unchanged from the former
  // inline `visibleDocs.map`; only its call site moved.
  const renderRow = (d: DocumentInfo): JSX.Element => {
    // Derive the per-row task in the PARENT (perf audit PERF-5): the activeTask module store
    // changes on EVERY 400 ms progress tick, so passing it whole would re-render every row each
    // tick. `rowTask` is the active task narrowed to THIS row (so it shows the busy/cancel pair)
    // or `null` — and `null` is Object.is-stable across ticks, so the ~all rows with no active
    // task keep their memo while only the one targeted row re-renders.
    const rowTask =
      activeTask != null &&
      activeTask.documentIds.includes(d.id) &&
      !isDocTaskTerminal(activeTask.status)
        ? activeTask
        : null
    return (
      <DocRow
        key={d.id}
        d={d}
        // Per-row BOOLEANS, never the whole Set/string (PERF-5): an unrelated row's selection
        // or menu change can't bust this row's memo.
        selected={selected.has(d.id)}
        menuOpen={menuOpenId === d.id}
        rowTask={rowTask}
        // `activeTask !== null` is a stable boolean across progress ticks (the menu items only
        // care whether ANY task runs, to disable themselves) — not the changing store object.
        anyTaskActive={activeTask !== null}
        t={t}
        tCount={tCount}
        lang={lang}
        sourcesById={sourcesById}
        ocrAvailable={ocrAvailable}
        translationAvailable={translationAvailable}
        busy={busy}
        previewLoading={previewLoading}
        showCheckbox={Boolean(onAskSelected)}
        isProjectSection={section.kind === 'project'}
        projectSectionId={section.kind === 'project' ? section.id : null}
        hasActiveProjects={activeProjects.length > 0}
        onToggleSelected={handleToggleSelected}
        setMenuOpenId={setMenuOpenId}
        onPreview={handlePreview}
        run={handleRun}
        onSummarize={handleSummarize}
        setTranslateDoc={setTranslateDoc}
        onOpenModels={handleOpenModels}
        onMakeSearchable={handleMakeSearchable}
        onBuildDeepIndex={handleBuildDeepIndex}
        onExport={handleExport}
        setAddToProjectFor={setAddToProjectFor}
        setProjectModal={setProjectModal}
        onKeepInLibrary={handleKeepInLibrary}
        onSetLifecycle={handleSetLifecycle}
        onRemoveFromCollection={handleRemoveFromCollection}
        setConfirmDelete={setConfirmDelete}
      />
    )
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
              onClick={() => setConfirmReindexAll({ kind: 'stale', docs: staleDocs })}
            >
              {busy === 'reindex-all'
                ? t('docs.reindexBusy')
                : t('docs.reindexAll', { count: staleDocs.length })}
            </Button>
          )}
          {/* Retry every failed import in one go, shown only on the Failed tab. Each row still
              has its own re-index, but on a tab full of failures one click beats N. */}
          {section.kind === 'failed' && failedDocs.length > 1 && (
            <Button
              size="sm"
              disabled={busy !== null || anyActive}
              title={t('docs.retryAllFailedTitle')}
              onClick={() => setConfirmReindexAll({ kind: 'failed', docs: failedDocs })}
            >
              {busy === 'reindex-all'
                ? t('docs.reindexBusy')
                : t('docs.retryAllFailed', { count: failedDocs.length })}
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
          the right-aligned Preview/⋯ column never drifts to a far edge on wide displays.
          PERF-2: when a real scroll viewport is resolved the list is WINDOWED (only the rows in/
          near the viewport mount); otherwise every row renders (the pre-PERF-2 path). */}
      <div className="doc-list" ref={docListRef}>
      {windowed ? (
        // Canonical `@tanstack/react-virtual` "scroll container with content above" layout: an
        // outer spacer of the full virtual height, and an inner stack translated to the first
        // visible row (offset by `scrollMargin`). Each row is wrapped in a measured element so a
        // variable-height row (banner / wrapping chips) corrects the estimate.
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${(virtualRows[0]?.start ?? 0) - rowVirtualizer.options.scrollMargin}px)`
            }}
          >
            {virtualRows.map((vi) => (
              <div key={vi.key} data-index={vi.index} ref={rowVirtualizer.measureElement}>
                {renderRow(visibleDocs[vi.index])}
              </div>
            ))}
          </div>
        </div>
      ) : (
        visibleDocs.map((d) => renderRow(d))
      )}
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
          if (pending) void startImport(pending.paths, pending.token)
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
        open={confirmReindexAll !== null}
        title={
          confirmReindexAll?.kind === 'failed'
            ? t('docs.retryAllConfirm.title', { count: confirmReindexAll.docs.length })
            : t('docs.reindexAllConfirm.title', { count: confirmReindexAll?.docs.length ?? 0 })
        }
        confirmLabel={
          confirmReindexAll?.kind === 'failed'
            ? t('docs.retryAllConfirm.confirm')
            : t('docs.reindexAllConfirm.confirm')
        }
        t={t}
        onConfirm={() => {
          const target = confirmReindexAll?.docs ?? []
          setConfirmReindexAll(null)
          void onReindexAll(target)
        }}
        onCancel={() => setConfirmReindexAll(null)}
      >
        <p className="hint">
          {confirmReindexAll?.kind === 'failed'
            ? t('docs.retryAllConfirm.body')
            : t('docs.reindexAllConfirm.body')}
        </p>
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
          {/* Source + target selects (TG-3, plan D5): native-name labels, untranslated by
              design (the Settings language-picker precedent). TranslateGemma needs an
              explicit source — there is no auto-detect. */}
          <div className="actions" style={{ alignItems: 'center' }}>
            <label>
              {t('docs.translateModal.from')}{' '}
              <select
                aria-label={t('docs.translateModal.from')}
                value={translateChoice.sourceLang}
                onChange={(e) =>
                  setTranslateChoice((c) => ({
                    ...c,
                    sourceLang: e.target.value as TranslationSourceLang
                  }))
                }
              >
                {TRANSLATION_LANGUAGE_CODES.map((code) => (
                  <option key={code} value={code}>
                    {TRANSLATION_NATIVE_NAMES[code]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('docs.translateModal.to')}{' '}
              <select
                aria-label={t('docs.translateModal.to')}
                value={translateChoice.targetLang}
                onChange={(e) =>
                  setTranslateChoice((c) => ({
                    ...c,
                    targetLang: e.target.value as TranslationTargetLang
                  }))
                }
              >
                {TRANSLATION_LANGUAGE_CODES.map((code) => (
                  <option key={code} value={code}>
                    {TRANSLATION_NATIVE_NAMES[code]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {translateChoice.sourceLang === translateChoice.targetLang && (
            <p className="hint">{t('docs.translateModal.sameLang')}</p>
          )}
          <div className="actions">
            <Button
              variant="primary"
              disabled={translateChoice.sourceLang === translateChoice.targetLang}
              onClick={() =>
                void onTranslate(
                  translateDoc,
                  translateChoice.sourceLang,
                  translateChoice.targetLang
                )
              }
            >
              {t('docs.translateModal.start')}
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
          originLine={previewDoc ? provenanceLine(previewDoc, sourcesById, t) : null}
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
