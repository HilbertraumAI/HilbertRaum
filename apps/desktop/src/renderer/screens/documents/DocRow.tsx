// One Documents row, extracted to its own sibling file (DX-3 split, full-audit-2026-06-29
// follow-up Phase 8). Relocated VERBATIM from `DocumentsScreen.tsx` — the JSX/classes/aria/
// conditionals and the PERF-5 memo discipline are byte-identical; only the per-row formatters
// and constants now come from `./format` rather than module scope. Behavior unchanged.

import { memo } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Badge, Banner, Button, Chip, Icon, Spinner } from '../../components'
import type { DocumentInfo, DocumentLifecycle } from '@shared/types'
import { generatedStaleness } from '@shared/types'
import { cancelActiveDocTask, type ActiveDocTask } from '../../lib/doctasks'
import { localizeServerCopy } from '../../lib/displayMap'
import type { I18n } from '../../i18n'
import type { UiLanguage } from '@shared/i18n'
import {
  ACTIVE_STATUSES,
  TASK_BUSY_LABEL,
  TASK_BUSY_TITLE,
  __docRowRenderCounts,
  badgeFor,
  isRetryableFailure,
  metaLine,
  provenanceLine,
  rowChips
} from './format'

/**
 * One document row (perf audit PERF-5): the checkbox + name/meta/provenance column + the trailing
 * cluster (chips, status badges, Preview + "⋯" overflow / busy-cancel pair). Memoized so an
 * unrelated parent re-render — a 400 ms task-progress tick on ANOTHER row, opening another row's ⋯
 * menu, toggling another row's selection — re-renders ONLY the affected row, not every row. The
 * crux (mirroring the chat `ConvRow`): the parent passes PER-ROW BOOLEANS (`selected`, `menuOpen`)
 * and a row-narrowed `rowTask` (null — Object.is-stable — for the rows with no active task), plus
 * stable handler identities (useEventCallback / setState setters), so this row's memo holds unless
 * ITS OWN props change. The DOM/classes/aria/conditionals are byte-identical to the former inline
 * map — only the data SOURCE changed (closure vars → props).
 */
export const DocRow = memo(function DocRow({
  d,
  selected,
  menuOpen,
  rowTask,
  anyTaskActive,
  t,
  tCount,
  lang,
  sourcesById,
  ocrAvailable,
  translationAvailable,
  busy,
  previewLoading,
  showCheckbox,
  isProjectSection,
  projectSectionId,
  hasActiveProjects,
  onToggleSelected,
  setMenuOpenId,
  onPreview,
  run,
  onSummarize,
  setTranslateDoc,
  onOpenModels,
  onMakeSearchable,
  onBuildDeepIndex,
  onExport,
  setAddToProjectFor,
  setProjectModal,
  onKeepInLibrary,
  onSetLifecycle,
  onRemoveFromCollection,
  setConfirmDelete,
  __onRender
}: {
  d: DocumentInfo
  /** Per-row boolean — NOT the whole `selected` Set (PERF-5). */
  selected: boolean
  /** Per-row boolean — NOT the whole `menuOpenId` string (PERF-5). */
  menuOpen: boolean
  /** The active task narrowed to THIS row, or null (Object.is-stable across ticks for inactive rows). */
  rowTask: ActiveDocTask | null
  /** Whether ANY task is active (a stable boolean) — gates the overflow items, not the live store. */
  anyTaskActive: boolean
  t: I18n['t']
  tCount: I18n['tCount']
  lang: UiLanguage
  sourcesById: ReadonlyMap<string, DocumentInfo>
  ocrAvailable: boolean
  /** The TranslateGemma sidecar resolved at startup (TG-3) — gates the Translate item. */
  translationAvailable: boolean
  busy: string | null
  previewLoading: boolean
  /** Whether the screen offers selection (i.e. `onAskSelected` is set) — gates the checkbox. */
  showCheckbox: boolean
  isProjectSection: boolean
  projectSectionId: string | null
  hasActiveProjects: boolean
  onToggleSelected: (id: string) => void
  setMenuOpenId: (id: string | null) => void
  onPreview: (d: DocumentInfo) => void
  run: (key: string, fn: () => Promise<unknown>) => void
  onSummarize: (d: DocumentInfo) => void
  setTranslateDoc: (d: DocumentInfo | null) => void
  /** Deep link for the translate model-missing state (TG-3) — opens the AI Model screen. */
  onOpenModels: () => void
  onMakeSearchable: (d: DocumentInfo) => void
  onBuildDeepIndex: (d: DocumentInfo) => void
  onExport: (d: DocumentInfo) => void
  setAddToProjectFor: (ids: string[] | null) => void
  setProjectModal: (m: { mode: 'create' | 'rename'; id?: string; name: string } | null) => void
  onKeepInLibrary: (id: string) => void
  onSetLifecycle: (id: string, lifecycle: DocumentLifecycle) => void
  onRemoveFromCollection: (documentId: string, collectionId: string) => void
  setConfirmDelete: (d: DocumentInfo | null) => void
  /** Perf-test seam (PERF-5): an optional render probe; undefined (a no-op) in production. */
  __onRender?: (id: string) => void
}): JSX.Element {
  // Perf-test render probe (PERF-5): bumps the module-scoped per-id counter so the memoization test
  // can assert an untouched row did NOT re-render. A Map write — effectively free; production
  // behaviour is identical with or without it.
  if (import.meta.env.DEV) __docRowRenderCounts.set(d.id, (__docRowRenderCounts.get(d.id) ?? 0) + 1) // DX-2: DEV-only, no-ops in prod
  __onRender?.(d.id)

  // Per-row derived values (moved inside DocRow, PERF-5) — pure functions of `d` + the stable
  // inputs (t/tCount/lang/sourcesById/ocrAvailable). Byte-identical output to the former inline map.
  const status = badgeFor(d, t)
  const chips = rowChips(d, t)
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
      className={`doc-row ${selected ? 'selected' : ''}`}
      onContextMenu={(e) => {
        // Right-click opens the same "⋯" overflow (mirrors the chat list). A failed row
        // has no overflow (just inline Remove / Try again), so leave the native menu.
        if (rowTask || d.status === 'failed') return
        e.preventDefault()
        setMenuOpenId(d.id)
      }}
    >
      {showCheckbox && d.status === 'indexed' && (
        <input
          type="checkbox"
          className="doc-select"
          checked={selected}
          aria-label={t('docs.selectAria', { title: d.title })}
          title={t('docs.selectTitle')}
          onChange={() => onToggleSelected(d.id)}
        />
      )}
      <Icon name="file" className="doc-row-icon" />
      <div className="doc-row-main">
        <div className="doc-row-title" title={d.originalPath ?? d.title}>
          {d.title}
        </div>
        <div className="doc-row-meta">{metaLine(d, lang, tCount)}</div>
        {/* Provenance for a generated document stays a quiet caption, not a badge (Task 2). */}
        {d.origin && <p className="hint doc-row-cap">{provenanceLine(d, sourcesById, t)}</p>}
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
              open={menuOpen}
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
                    <DropdownMenu.Item className="menu-item" disabled={anyTaskActive} onSelect={() => void onSummarize(d)}>
                      {d.summary ? t('docs.summarizeAgain') : t('docs.summarize')}
                    </DropdownMenu.Item>
                  )}
                  {/* Translation requires the TranslateGemma model (TG-3, plan O2/D3): without
                      it the item disables and the sibling item below deep-links to the AI Model
                      screen — a friendly install path, never a dead end. */}
                  {canDocTasks && (
                    <DropdownMenu.Item
                      className="menu-item"
                      disabled={anyTaskActive || !translationAvailable}
                      title={translationAvailable ? undefined : t('docs.translateNoModelTitle')}
                      onSelect={() => setTranslateDoc(d)}
                    >
                      {t('docs.translate')}
                    </DropdownMenu.Item>
                  )}
                  {canDocTasks && !translationAvailable && (
                    <DropdownMenu.Item
                      className="menu-item"
                      title={t('docs.translateNoModelTitle')}
                      onSelect={onOpenModels}
                    >
                      {t('docs.translateNoModel')}
                    </DropdownMenu.Item>
                  )}
                  {/* Contextual: make a detected scan searchable (OCR). */}
                  {showOcr && (
                    <DropdownMenu.Item className="menu-item" disabled={anyTaskActive} onSelect={() => void onMakeSearchable(d)}>
                      {t('docs.makeSearchable')}
                    </DropdownMenu.Item>
                  )}
                  {/* Build deep index — disappears once the doc is deeply indexed (Task 2);
                      C4: a legacy not-fully-chunked doc offers "Re-index for deep index". */}
                  {canDeepIndex && (
                    <DropdownMenu.Item className="menu-item" disabled={anyTaskActive} onSelect={() => void onBuildDeepIndex(d)}>
                      {t(d.fullyChunked === false ? 'docs.deepIndex.reindexFirst' : 'docs.deepIndex.build')}
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item
                    className="menu-item"
                    disabled={ACTIVE_STATUSES.has(d.status) || anyTaskActive}
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
                      {hasActiveProjects ? (
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
                      {isProjectSection && (d.collections ?? []).some((c) => c.id === projectSectionId) && (
                        <DropdownMenu.Item className="menu-item" onSelect={() => void onRemoveFromCollection(d.id, projectSectionId!)}>
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
})
