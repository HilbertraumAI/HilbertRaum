// Documents-screen pure formatters + presentational constants (DX-3 split,
// full-audit-2026-06-29 follow-up Phase 8). Relocated VERBATIM from `DocumentsScreen.tsx` —
// these are pure functions of their args (no React state, no screen closures), so `DocRow`,
// the PreviewModal origin line, and the screen body can all import them. Behavior unchanged.

import type { ReactNode } from 'react'
import type { BadgeTone } from '../../components'
import type { DocTaskKind, DocumentInfo, IngestionStatus } from '@shared/types'
import { provenanceView } from '@shared/types'
import { en, type MessageKey, type UiLanguage } from '@shared/i18n'
import type { I18n } from '../../i18n'
import { unsupportedTypeExt } from '../../lib/displayMap'

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

export const ACTIVE_STATUSES: ReadonlySet<IngestionStatus> = new Set([
  'queued',
  'extracting',
  'chunking',
  'embedding'
])

/**
 * Perf-test seam (PERF-5): a module-scoped per-id render counter that {@link DocRow} bumps in its
 * body. It lets the memoization test assert that an unrelated parent re-render (toggling another
 * row's selection / opening another row's ⋯ menu) re-renders ONLY the affected row. It is a Map
 * write per row render — effectively free — and is the ONLY observability hook here; production
 * behaviour is identical with or without it. Reset by the test between renders.
 */
export const __docRowRenderCounts = new Map<string, number>()

/**
 * PERF-2 (= PERF-5 Part B; full-audit-2026-06-29 follow-up, Phase 4) — list windowing.
 * Estimated row height for `@tanstack/react-virtual`: `.doc-row` is `min-height: 56px` + a 1px
 * bottom border. It is only the FIRST-PAINT estimate — each rendered row reports its true height
 * via `measureElement`, so a taller row (a failed-import error banner, a stale-embeddings notice,
 * a wrapping chip cluster) self-corrects. Overscan keeps a cushion of off-screen rows so a small
 * estimate error never flashes a gap.
 */
export const DOC_ROW_ESTIMATED_HEIGHT = 57
export const DOC_ROW_OVERSCAN = 10

/**
 * Per-document status badge. Audio in `extracting` is honestly "Transcribing…" —
 * listening to a recording takes real time — with the coarse percent the
 * docs IPC merges in while whisper works.
 */
export function badgeFor(d: DocumentInfo, t: I18n['t']): { label: string; tone: BadgeTone; icon: string } {
  const base = STATUS_BADGE[d.status]
  if (d.status === 'extracting' && d.mimeType?.startsWith('audio/')) {
    const pct = d.transcriptionProgress != null ? ` ${d.transcriptionProgress}%` : ''
    return { tone: base.tone, icon: base.icon, label: `${t('docs.status.transcribing')}${pct}` }
  }
  return { tone: base.tone, icon: base.icon, label: t(base.labelKey) }
}

/** A source document's title for a provenance line (the source may be gone). FE-8: resolve via
 *  the `sourcesById` Map instead of a linear `docs.find` per provenance line (called once per
 *  generated row + the preview modal). */
function titleOf(id: string, sourcesById: ReadonlyMap<string, DocumentInfo>, t: I18n['t']): string {
  return sourcesById.get(id)?.title ?? t('docs.removedDocFallback')
}

/**
 * Quiet provenance line for a generated document, rendered from the structured
 * `GeneratedProvenance` view (kind + source ids) so old and new rows take one path
 * (plan §15.3). Source titles resolve tolerantly — a deleted source falls back to the
 * "removed document" copy. Module-scope (PERF-5) so {@link DocRow} can call it with props.
 */
export function provenanceLine(d: DocumentInfo, sourcesById: ReadonlyMap<string, DocumentInfo>, t: I18n['t']): ReactNode {
  if (!d.origin) return null
  const { kind, sourceDocumentIds } = provenanceView(d.origin)
  if (kind === 'compare') {
    const [a, b] = sourceDocumentIds
    return (
      <>
        {t('docs.provenance.compareBefore')}
        <b>{titleOf(a, sourcesById, t)}</b>
        {t('docs.provenance.compareMiddle')}
        <b>{titleOf(b, sourcesById, t)}</b>
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
      <b>{titleOf(sourceDocumentIds[0], sourcesById, t)}</b>
    </>
  )
}

/**
 * The uniform location/project chips for a row (Task 3): Library / Temporary / Generated /
 * Archived AND project tags all render as the SAME neutral Chip — location is never a status
 * badge or a blue pill. Deduped, in a stable order. Returns plain labels; the caller renders
 * them as <Chip>. Module-scope (PERF-5) so {@link DocRow} can call it with `t`.
 */
export function rowChips(d: DocumentInfo, t: I18n['t']): string[] {
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

/** Compact muted meta line: "PDF · 2.0 KB · 7 sections" (§5/§6 — technical, visually secondary).
 *  Module-scope (PERF-5) so {@link DocRow} can call it with `lang`/`tCount`. */
export function metaLine(d: DocumentInfo, lang: UiLanguage, tCount: I18n['tCount']): string {
  const parts: string[] = [friendlyMimeLabel(d.mimeType)]
  if (d.sizeBytes != null) parts.push(formatSize(d.sizeBytes, lang))
  if (d.chunkCount > 0) parts.push(tCount('docs.meta.sectionsCount', d.chunkCount))
  return parts.join(' · ')
}

// Per-kind busy copy for the row spinner (guidelines §7 — speak human, no jargon).
export const TASK_BUSY_LABEL: Record<DocTaskKind, MessageKey> = {
  summary: 'docs.task.summaryBusy',
  translation: 'docs.task.translationBusy',
  compare: 'docs.task.compareBusy',
  ocr: 'docs.task.ocrBusy',
  tree: 'docs.task.treeBusy',
  extract: 'docs.task.extractBusy',
  categorize: 'docs.task.categorizeBusy'
}
export const TASK_BUSY_TITLE: Record<DocTaskKind, MessageKey> = {
  summary: 'docs.task.summaryBusyTitle',
  translation: 'docs.task.translationBusyTitle',
  compare: 'docs.task.compareBusyTitle',
  ocr: 'docs.task.ocrBusyTitle',
  tree: 'docs.task.treeBusyTitle',
  extract: 'docs.task.extractBusyTitle',
  categorize: 'docs.task.categorizeBusyTitle'
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
export function formatSize(bytes: number | null, lang: UiLanguage): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const fmt = (n: number): string =>
    n.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} KB`
  return `${fmt(bytes / (1024 * 1024))} MB`
}
