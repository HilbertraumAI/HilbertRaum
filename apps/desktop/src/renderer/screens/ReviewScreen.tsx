import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { EvidenceReviewDetail, EvidenceReviewItem } from '@shared/types'
import { AssistantMarkdown } from '../chat/AssistantMarkdownLazy'
import { Button, ConfirmDialog, Modal, useToast } from '../components'
import { formatCitationLabel, localizeServerCopy } from '../lib/displayMap'
import {
  acknowledgeReviewFreshness,
  bulkClearDecisions,
  bulkMarkHeadingsNotApplicable,
  bulkMarkUndecidedFollowUp,
  editReviewHead,
  editReviewItem,
  flushReviewSession,
  getReviewSessionSnapshot,
  linkEvidence,
  markReviewReady,
  openReviewSession,
  reopenReview,
  retryReviewSave,
  subscribeReviewSession,
  unlinkEvidence,
  type ReviewHandoffTarget
} from '../lib/reviewSession'
import { DecisionControl } from '../review/DecisionControl'
import { EvidencePane, evidencePaneMode } from '../review/EvidencePane'
import { ReviewSummaryView } from '../review/ReviewSummaryView'
import { SourceContextModal } from '../review/SourceContextModal'
import { useT, type I18n } from '../i18n'

// The evidence-review workspace (EP-1 plan §7.3, spec §10/§11): a dedicated full-window
// screen — NOT in the nav rail, reachable only through App's handoff slot — where a user
// reviews one persisted answer against its FROZEN source snapshots. Everything renders
// from `EvidenceReviewDetail` (the snapshot), never the live message; opening and
// operating the screen performs ZERO model-runtime and ZERO network activity (spec
// FR-2/FR-12) — every call on this surface is a local `evidence:*` SQLite round trip.
//
// Layout (spec §11.1): two panes — answer (immutable snapshot text via AssistantMarkdown,
// item boundaries, decision chips, notes) and evidence (source cards + honesty captions).
// On narrow windows the evidence pane becomes a Modal drawer opened from the selected
// item (`Modal width='wide'`; focus-return is Radix's built-in `useReturnFocus`).
// The rail's app-wide Local/Offline indicator already shows on this screen — §11.2's
// header indicator is deliberately NOT duplicated (design-guidelines §12.1 #2: ONE
// ambient privacy signal, no per-screen copies).

/** The evidence pane collapses to a drawer below this width (spec §11.1). */
const NARROW_QUERY = '(max-width: 980px)'

function subscribeNarrow(onChange: () => void): () => void {
  const mq = window.matchMedia?.(NARROW_QUERY)
  if (!mq) return () => {}
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

function readNarrow(): boolean {
  return window.matchMedia?.(NARROW_QUERY)?.matches ?? false
}

export function ReviewScreen({
  handoff,
  onNavigate
}: {
  handoff: ReviewHandoffTarget
  onNavigate: (target: string) => void
}): JSX.Element {
  const { t, tCount, lang } = useT()
  const session = useSyncExternalStore(subscribeReviewSession, getReviewSessionSnapshot)
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow)
  const showToast = useToast()
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  /** P4 (D-5): the snapshot key whose source-in-context modal is open; null = closed. */
  const [contextKey, setContextKey] = useState<string | null>(null)
  const questionId = useId()

  useEffect(() => {
    void openReviewSession(handoff)
  }, [handoff])

  // Flush on screen exit (plan §7.5): unmount here = in-app navigation while the vault is
  // still unlocked. The LOCK path flushes earlier — App.lockNow awaits the flush BEFORE
  // `lockWorkspace()` and then purges the store (lockPurge.ts).
  useEffect(() => {
    return () => {
      void flushReviewSession()
    }
  }, [])

  const detail = session.detail
  const selectedItem = detail?.items.find((i) => i.id === selectedItemId) ?? null

  async function handleMarkReady(): Promise<void> {
    setActionBusy(true)
    try {
      const result = await markReviewReady()
      if (result.outcome === 'ready') showToast(t('review.toast.ready'))
      // 'ineligible' needs no banner: main's authoritative gate landed in the detail and
      // the summary's "N of M decided" hint says why (never rendered as a failure).
    } finally {
      setActionBusy(false)
    }
  }

  async function handleReopen(): Promise<void> {
    setActionBusy(true)
    try {
      await reopenReview()
    } finally {
      setActionBusy(false)
    }
  }

  function commitRename(): void {
    if (renameDraft != null) {
      const next = renameDraft.trim()
      // The service ignores empty renames (a review is never unnamed) — mirror it here.
      if (next.length > 0 && next !== detail?.title) editReviewHead({ title: next })
    }
    setRenameDraft(null)
  }

  // Before the open effect has produced either a detail or an error (first frame, and
  // while the load runs) the screen is loading — never a flash of "not found".
  if (session.loading || (!detail && !session.openError)) {
    return (
      <div className="screen review-screen" aria-busy="true">
        <p className="hint">{t('review.loading')}</p>
      </div>
    )
  }

  if (session.openError || !detail) {
    return (
      <div className="screen review-screen">
        <div className="card">
          <p className="hint">
            {session.openError?.kind === 'failed'
              ? localizeServerCopy(t, session.openError.message)
              : t('review.notFound')}
          </p>
          <Button onClick={() => onNavigate('chat')}>‹ {t('review.back')}</Button>
        </div>
      </div>
    )
  }

  const paneMode = evidencePaneMode(detail.coverageSnapshot)
  const followUps = detail.items.filter((i) => i.decision === 'follow_up').length
  // Ready = read-only for ITEM-LEVEL editing (FIX-1, spec §18.4): decisions, notes, links
  // and bulk actions disable (main refuses their writes too); head edits (rename, reviewer
  // label, general note) and the summary's Reopen stay live.
  const readOnly = detail.status === 'ready'
  // P4: the freshness UI renders EXCLUSIVELY from the store's refresh result (write-path
  // returns carry a constant-false overlay and must never hide a real warning).
  const freshness = session.freshness

  const evidencePane = (
    <EvidencePane
      sources={detail.sources}
      coverage={detail.coverageSnapshot}
      selectedItem={selectedItem}
      readOnly={readOnly}
      freshness={freshness}
      onLink={(itemId, key) => void linkEvidence(itemId, key, null)}
      onUnlink={(itemId, key) => void unlinkEvidence(itemId, key)}
      onSetRelation={(itemId, key, relation) => void linkEvidence(itemId, key, relation)}
      onOpenContext={(key) => setContextKey(key)}
      t={t}
      tCount={tCount}
    />
  )

  return (
    <div className="screen review-screen">
      <div className="review-head">
        <Button size="sm" variant="ghost" className="review-back" onClick={() => onNavigate('chat')}>
          ‹ {t('review.back')}
        </Button>
        {renameDraft == null ? (
          <>
            {/* The default title is persist-canonical English ('Evidence review') — the
                display map localizes it; a user-set title passes through verbatim. */}
            <h1 className="review-title">{localizeServerCopy(t, detail.title)}</h1>
            <Button size="sm" variant="ghost" onClick={() => setRenameDraft(detail.title)}>
              {t('review.rename')}
            </Button>
          </>
        ) : (
          <>
            {/* Renaming edits the RAW stored title (canonical, not the localized display)
                so a kept default stays canonical across languages. */}
            <input
              className="review-rename-input"
              aria-label={t('review.rename.label')}
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenameDraft(null)
              }}
            />
            <Button size="sm" onClick={commitRename}>
              {t('review.rename.save')}
            </Button>
          </>
        )}
        <span className="review-status-chip">
          <span aria-hidden="true">{detail.status === 'ready' ? '✓' : '○'}</span>{' '}
          {t(detail.status === 'ready' ? 'review.status.ready' : 'review.status.draft')}
        </span>
        {/* P4 (spec §18.4): Outdated is an ADDITIONAL chip — the Draft/Ready fact stays
            visible (outdated never erases completion). Text + glyph, never color-only. */}
        {freshness?.outdated && (
          <span className="review-status-chip review-outdated-chip">
            <span aria-hidden="true">⚠</span> {t('review.status.outdated')}
          </span>
        )}
        {/* FIX-1: the quiet "why is everything disabled" line next to the chip. */}
        {readOnly && <span className="hint review-readonly-hint">{t('review.readonlyHint')}</span>}
        <SaveStateLine state={session.saveState} error={session.saveError} t={t} />
      </div>

      {/* P4 Outdated banner (spec §15.5/§21.3): names the drift, keeps the §21.3 options
          visible, and carries the acknowledge action. It never blocks reading or editing —
          only export waits for the acknowledge (§28.6). role=status: it appears async
          after the freshness check lands. The fact list includes NEWLY-missing sources
          (fix round FIX-5): a new deletion lapses a prior acknowledge by adding a drift
          fact, so the re-demand must NAME that fact — even though deletion alone never
          opens this banner (it does not flip outdated). Creation-missing sources are not
          drift and stay off the list (their badge lives on the card). */}
      {freshness?.outdated && (
        <div className="review-outdated-banner" role="status">
          <p className="review-outdated-title">
            <span aria-hidden="true">⚠</span> <strong>{t('review.outdated.title')}</strong>
          </p>
          <ul className="review-outdated-facts">
            {freshness.answerState === 'changed' && <li>{t('review.outdated.answerChanged')}</li>}
            {freshness.coverageState === 'changed' && (
              <li>{t('review.outdated.coverageChanged')}</li>
            )}
            {(freshness.sources ?? []).filter((s) => s.state === 'changed').length > 0 && (
              <li>
                {tCount(
                  'review.outdated.sourcesChanged',
                  (freshness.sources ?? []).filter((s) => s.state === 'changed').length
                )}
              </li>
            )}
            {countMissingNow(freshness, detail) > 0 && (
              <li>{tCount('review.summary.sourcesMissingNow', countMissingNow(freshness, detail))}</li>
            )}
          </ul>
          <p className="hint">{t('review.outdated.keepNote')}</p>
          {freshness.acknowledgedAt ? (
            <p className="hint review-outdated-acked">
              <span aria-hidden="true">✓</span>{' '}
              {t('review.outdated.acknowledgedAt', {
                date: formatFreshnessDate(freshness.acknowledgedAt, lang)
              })}
            </p>
          ) : (
            <Button size="sm" onClick={() => void acknowledgeReviewFreshness()}>
              {t('review.outdated.acknowledge')}
            </Button>
          )}
        </div>
      )}

      <div className={narrow ? 'review-panes narrow' : 'review-panes'}>
        <div className="review-answer-pane" role="region" aria-label={t('review.answerPane.aria')}>
          {detail.questionSnapshot !== '' && (
            <div className="review-question">
              <button
                type="button"
                className="sources-toggle"
                id={`${questionId}-toggle`}
                aria-expanded={questionOpen}
                aria-controls={`${questionId}-region`}
                onClick={() => setQuestionOpen((v) => !v)}
              >
                <span aria-hidden="true">{questionOpen ? '▾' : '▸'}</span>{' '}
                {t('review.question.toggle')}
              </button>
              {questionOpen && (
                <div
                  className="review-question-text"
                  id={`${questionId}-region`}
                  role="region"
                  aria-labelledby={`${questionId}-toggle`}
                >
                  {detail.questionSnapshot}
                </div>
              )}
            </div>
          )}

          {/* Bulk actions hide entirely while ready (FIX-1) — every one of them is an
              item-level write the main side now refuses. */}
          {!readOnly && (
          <div className="review-bulk-row">
            {/* Conservative bulk actions ONLY (spec §14.4) — there is deliberately no
                "mark all supported" anywhere on this screen (tested). */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="sm">{t('review.bulk.menu')} ▾</Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item
                    className="menu-item"
                    onSelect={() => bulkMarkHeadingsNotApplicable()}
                  >
                    {t('review.bulk.headingsNa')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="menu-item"
                    onSelect={() => bulkMarkUndecidedFollowUp()}
                  >
                    {t('review.bulk.followUp')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => setConfirmClear(true)}>
                    {t('review.bulk.clear')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          )}

          <ol className="review-items">
            {detail.items.map((item, index) => (
              <ReviewItemRow
                key={item.id}
                item={item}
                index={index}
                detail={detail}
                paneMode={paneMode}
                selected={selectedItemId === item.id}
                onSelect={() => setSelectedItemId(item.id)}
                narrow={narrow}
                readOnly={readOnly}
                onOpenDrawer={() => {
                  setSelectedItemId(item.id)
                  setDrawerOpen(true)
                }}
                t={t}
              />
            ))}
          </ol>
        </div>

        {!narrow && <aside className="review-evidence-pane">{evidencePane}</aside>}
      </div>

      <footer className="review-foot">
        <span className="review-progress">
          {t('review.progress', {
            decided: detail.gate.decidedTotal,
            required: detail.gate.requiredTotal
          })}
        </span>
        {followUps > 0 && (
          <span className="hint">{tCount('review.progress.followUps', followUps)}</span>
        )}
        {detail.generationSnapshot?.answerTruncated === true && (
          <span className="hint review-truncated">
            <span aria-hidden="true">⚠</span> {t('review.summary.truncated')}
          </span>
        )}
        <span className="review-foot-spacer" />
        <Button variant="primary" onClick={() => setSummaryOpen(true)}>
          {t('review.footer.summary')}
        </Button>
      </footer>

      {/* Narrow-window evidence drawer (spec §11.1): the existing Modal is the drawer —
          focus trap + Esc + focus-return to the opening "View evidence" button come from
          Radix (Dialog.tsx useReturnFocus). */}
      <Modal
        open={narrow && drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={t('review.evidence.title')}
        width="wide"
        t={t}
      >
        {evidencePane}
      </Modal>

      <Modal
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        title={t('review.footer.summary')}
        width="wide"
        t={t}
      >
        <ReviewSummaryView
          detail={detail}
          freshness={freshness}
          onEditHead={editReviewHead}
          onMarkReady={() => void handleMarkReady()}
          onReopen={() => void handleReopen()}
          onAcknowledge={() => void acknowledgeReviewFreshness()}
          busy={actionBusy}
          t={t}
          tCount={tCount}
          lang={lang}
        />
      </Modal>

      {/* P4 (D-5): source-in-context — main-side resolution from the review's own
          snapshot; the modal fetches on open and highlights the persisted excerpt. */}
      <SourceContextModal
        open={contextKey != null}
        reviewId={detail.id}
        sourceKey={contextKey}
        onClose={() => setContextKey(null)}
        t={t}
      />

      <ConfirmDialog
        open={confirmClear}
        title={t('review.bulk.clearConfirmTitle')}
        confirmLabel={t('review.bulk.clearConfirm')}
        t={t}
        onConfirm={() => {
          bulkClearDecisions()
          setConfirmClear(false)
        }}
        onCancel={() => setConfirmClear(false)}
      >
        <p>{t('review.bulk.clearConfirmBody')}</p>
      </ConfirmDialog>
    </div>
  )
}

/** NEWLY-missing sources in a freshness verdict: state 'missing' minus the ones already
 *  missing at creation (the same rule the summary + pack use — creation-missing is a
 *  recorded fact, not drift). */
function countMissingNow(
  freshness: { sources?: { key: string; state: string }[] },
  detail: EvidenceReviewDetail
): number {
  const missingAtCreation = new Set(
    detail.sources.filter((s) => s.availabilityAtCreation === 'missing').map((s) => s.key)
  )
  return (freshness.sources ?? []).filter(
    (s) => s.state === 'missing' && !missingAtCreation.has(s.key)
  ).length
}

/** Locale-aware acknowledge stamp (the ReviewSummaryView `formatWhen` idiom); raw string
 *  when unparseable — never an invented date. */
function formatFreshnessDate(iso: string, lang: I18n['lang']): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(lang, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}

/** Quiet auto-save status (guidelines §6 — labelled text, no bare spinner). */
function SaveStateLine({
  state,
  error,
  t
}: {
  state: 'idle' | 'pending' | 'saved' | 'error'
  error: string | null
  t: I18n['t']
}): JSX.Element | null {
  if (state === 'idle') return null
  if (state === 'error') {
    return (
      <span className="review-save-state error" role="alert">
        {error != null ? localizeServerCopy(t, error) : t('review.autosave.error')}{' '}
        {/* FIX-2d: retry re-flushes pending edits; with nothing pending (stale handle)
            it reconciles with the DB instead of no-oping forever. */}
        <button type="button" className="msg-action" onClick={() => void retryReviewSave()}>
          {t('review.autosave.retry')}
        </button>
      </span>
    )
  }
  return (
    <span className="review-save-state" role="status">
      {state === 'pending' ? t('review.autosave.saving') : t('review.autosave.saved')}
    </span>
  )
}

/**
 * One review item (spec §12): the frozen block text, its evidence-marker honesty note,
 * linked-evidence chips, the 6-value decision radio group, and the note field. Focusing
 * ANY control inside selects the item (keyboard parity with click — spec §28.10).
 */
function ReviewItemRow({
  item,
  index,
  detail,
  paneMode,
  selected,
  onSelect,
  narrow,
  readOnly,
  onOpenDrawer,
  t
}: {
  item: EvidenceReviewItem
  index: number
  detail: EvidenceReviewDetail
  paneMode: 'relevance' | 'whole_doc' | 'structured'
  selected: boolean
  onSelect: () => void
  narrow: boolean
  /** Ready review (FIX-1): decision/note/unlink controls disable until reopened. */
  readOnly: boolean
  onOpenDrawer: () => void
  t: I18n['t']
}): JSX.Element {
  const isHeading = item.blockKind === 'heading'
  // Honesty note (spec §10.3/§13.2/§13.3): whole-document items say DERIVED, never cited;
  // an unmarked item in a citation-bearing answer says "no direct source marker" — which
  // must never be presented as "false". Headings stay quiet (they default Not applicable).
  const note = isHeading
    ? null
    : paneMode === 'whole_doc'
      ? t('review.item.wholeDocDerived')
      : item.links.some((l) => l.origin === 'answer_marker')
        ? null
        : t('review.item.noMarker')
  return (
    <li
      className={selected ? 'review-item selected' : 'review-item'}
      aria-label={t('review.item.aria', { n: index + 1 })}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      onFocusCapture={onSelect}
    >
      <div className="review-item-text md">
        {/* The FROZEN snapshot slice — markers localize at render (D68), text never edits. */}
        <AssistantMarkdown text={localizeServerCopy(t, item.textSnapshot)} />
      </div>
      {note && <p className="hint review-item-note">{note}</p>}
      {item.links.length > 0 && (
        <div className="review-item-links">
          {item.links.map((link) => {
            const source = detail.sources.find((s) => s.key === link.evidenceKey)
            const marker =
              source?.kind === 'direct_excerpt' && source.machineLabel
                ? `[${formatCitationLabel(t, source.machineLabel)}] `
                : ''
            const title = source?.documentTitle ?? link.evidenceKey
            return (
              <span key={link.evidenceKey} className="review-item-link">
                {marker}
                {title}
                <span className="review-link-origin">
                  {' · '}
                  {t(link.origin === 'answer_marker' ? 'review.link.cited' : 'review.link.reviewer')}
                </span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`${t('review.link.remove')}: ${title}`}
                  disabled={readOnly}
                  onClick={() => void unlinkEvidence(item.id, link.evidenceKey)}
                >
                  ✕
                </button>
              </span>
            )
          })}
        </div>
      )}
      <DecisionControl
        value={item.decision}
        onChange={(decision) => editReviewItem(item.id, { decision })}
        t={t}
        disabled={readOnly}
      />
      <label className="review-note-label">
        <span className="hint">{t('review.item.noteLabel')}</span>
        <textarea
          className="review-note-input"
          rows={2}
          placeholder={t('review.item.notePlaceholder')}
          value={item.reviewerNote ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            editReviewItem(item.id, {
              reviewerNote: e.target.value === '' ? null : e.target.value
            })
          }
        />
      </label>
      {narrow && (
        <Button size="sm" onClick={onOpenDrawer}>
          {t('review.item.viewEvidence')}
        </Button>
      )}
    </li>
  )
}
