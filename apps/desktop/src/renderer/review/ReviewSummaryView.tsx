import type { EvidenceReviewDetail, ReviewDecision } from '@shared/types'
import { CoverageMeter, Button } from '../components'
import { DECISION_GLYPH, DECISION_ORDER, decisionLabelKey } from './DecisionControl'
import type { I18n } from '../i18n'

// The review summary view (EP-1 plan §7.6, spec §10.4/§11.6): status, decision counts,
// coverage + truncation honesty, source-integrity facts, generation metadata (absent =
// "Unavailable", never invented — spec §25.5), reviewer label + general note, and the
// D-7-gated "Mark review ready" / "Reopen review" actions. Rendered inside the wide Modal
// the screen opens from its footer.
//
// Phase 3 seam: the "Create evidence pack" export action MOUNTS IN THE ACTIONS ROW at the
// bottom of this view (beside Mark ready), and the export-history list below it stops
// being empty. Keep both anchors when restructuring.

export function ReviewSummaryView({
  detail,
  onEditHead,
  onMarkReady,
  onReopen,
  busy,
  t,
  tCount,
  lang
}: {
  detail: EvidenceReviewDetail
  onEditHead: (patch: { reviewerLabel?: string | null; generalNote?: string | null }) => void
  onMarkReady: () => void
  onReopen: () => void
  /** True while a mark-ready/reopen round trip is in flight (buttons disable). */
  busy: boolean
  t: I18n['t']
  tCount: I18n['tCount']
  lang: I18n['lang']
}): JSX.Element {
  const counts = new Map<ReviewDecision, number>()
  for (const item of detail.items) {
    counts.set(item.decision, (counts.get(item.decision) ?? 0) + 1)
  }
  const unresolved = detail.sources.filter((s) => s.identity === 'unresolved').length
  const missing = detail.sources.filter((s) => s.availabilityAtCreation === 'missing').length
  const gen = detail.generationSnapshot
  const unavailable = t('review.summary.unavailable')
  const completed =
    detail.status === 'ready' && detail.completedAt ? formatWhen(detail.completedAt, lang) : null
  return (
    <div className="review-summary">
      <section>
        <h3>{t('review.summary.status')}</h3>
        <p>
          <span className="review-status-chip">
            <span aria-hidden="true">{detail.status === 'ready' ? '✓' : '○'}</span>{' '}
            {t(detail.status === 'ready' ? 'review.status.ready' : 'review.status.draft')}
          </span>{' '}
          {completed && <span className="hint">{t('review.completedAt', { date: completed })}</span>}
        </p>
      </section>

      <section>
        <h3>{t('review.summary.decisions')}</h3>
        <ul className="review-summary-counts">
          {DECISION_ORDER.map((d) => (
            <li key={d}>
              <span aria-hidden="true">{DECISION_GLYPH[d]}</span> {t(decisionLabelKey(d))}:{' '}
              {counts.get(d) ?? 0}
            </li>
          ))}
        </ul>
        <p className="hint">
          {t('review.progress', {
            decided: detail.gate.decidedTotal,
            required: detail.gate.requiredTotal
          })}
        </p>
      </section>

      <section>
        <h3>{t('review.summary.sources')}</h3>
        <p>{tCount('review.summary.sourcesCount', detail.sources.length)}</p>
        {unresolved > 0 && (
          <p className="hint">
            <span aria-hidden="true">?</span> {tCount('review.summary.sourcesUnresolved', unresolved)}
          </p>
        )}
        {missing > 0 && (
          <p className="hint">
            <span aria-hidden="true">⚠</span> {tCount('review.summary.sourcesMissing', missing)}
          </p>
        )}
        {/* Coverage honesty (spec §15/§28.4): the persisted breadth claim, same vocabulary
            as the chat's meter; absent coverage renders nothing (legacy answers). */}
        {detail.coverageSnapshot && <CoverageMeter coverage={detail.coverageSnapshot} />}
        {gen?.answerTruncated === true && (
          <p className="hint review-truncated">
            <span aria-hidden="true">⚠</span> {t('review.summary.truncated')}
          </p>
        )}
      </section>

      <section>
        <h3>{t('review.summary.generation')}</h3>
        <dl className="review-summary-meta">
          <dt>{t('review.summary.model')}</dt>
          <dd>{gen?.modelDisplayName ?? gen?.modelId ?? unavailable}</dd>
          <dt>{t('review.summary.generatedAt')}</dt>
          <dd>{gen?.generatedAt ? formatWhen(gen.generatedAt, lang) : unavailable}</dd>
          <dt>{t('review.summary.appVersion')}</dt>
          <dd>{gen?.appVersion ?? unavailable}</dd>
          {gen?.skillDisplayName != null && (
            <>
              <dt>{t('review.summary.skill')}</dt>
              <dd>{gen.skillDisplayName}</dd>
            </>
          )}
        </dl>
      </section>

      <section>
        <h3>{t('review.summary.reviewerLabel')}</h3>
        {/* D-3: a free-text label, never a system identity. Debounce-saved via the store. */}
        <input
          type="text"
          className="review-reviewer-input"
          aria-label={t('review.summary.reviewerLabel')}
          placeholder={t('review.summary.reviewerPlaceholder')}
          value={detail.reviewerLabel ?? ''}
          onChange={(e) => onEditHead({ reviewerLabel: e.target.value === '' ? null : e.target.value })}
        />
        <h3>{t('review.summary.generalNote')}</h3>
        <textarea
          className="review-note-input"
          aria-label={t('review.summary.generalNote')}
          placeholder={t('review.summary.generalNotePlaceholder')}
          rows={3}
          value={detail.generalNote ?? ''}
          onChange={(e) => onEditHead({ generalNote: e.target.value === '' ? null : e.target.value })}
        />
      </section>

      {detail.exports.length > 0 && (
        <section>
          <h3>{t('review.summary.exports')}</h3>
          <ul className="review-summary-exports">
            {detail.exports.map((x) => (
              <li key={x.id}>
                {x.fileName} · {x.format} · {formatWhen(x.createdAt, lang)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="review-summary-actions">
        {/* D-7 gate: disabled until every required item is decided; the hint says WHY in
            "N of M" terms — guidance, never a failure state (P1 handoff). */}
        {detail.status === 'draft' && (
          <>
            {!detail.gate.eligible && (
              <p className="hint review-gate-hint">
                {t('review.summary.gateHint', {
                  decided: detail.gate.decidedTotal,
                  required: detail.gate.requiredTotal
                })}
              </p>
            )}
            <Button
              variant="primary"
              disabled={busy || !detail.gate.eligible}
              onClick={onMarkReady}
            >
              {t('review.summary.markReady')}
            </Button>
          </>
        )}
        {detail.status === 'ready' && (
          <Button disabled={busy} onClick={onReopen}>
            {t('review.summary.reopen')}
          </Button>
        )}
        {/* Phase 3 mounts the "Create evidence pack" action here (plan §8.4). */}
      </div>
    </div>
  )
}

/** Locale-aware timestamp (the PreviewModal/ImageHistory idiom); raw string when unparseable. */
function formatWhen(iso: string, lang: I18n['lang']): string {
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
