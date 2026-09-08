import { useEffect, useId, useRef, useState } from 'react'
import type { Citation, CoverageMode, PackArticleSaveResult } from '@shared/types'
import { Spinner } from '../components'
import { useT, type I18n } from '../i18n'
import { friendlyIpcError } from '../lib/errors'
import { formatCitationLabel } from '../lib/displayMap'

// "▸ Sources (N)" (guidelines §3): citations stay attached to the answer as an inline
// disclosure, collapsed by default, with `aria-controls` wiring the toggle to the expanded
// region (FE-D, full-audit-2026-06-29 follow-up Phase 5).
//
// Two honestly-different kinds of "citation", told apart by the answer's coverage mode
// (FE-B / F11 renderer half, same round):
//   - RELEVANCE (mode `relevance`, or a pre-migration NULL-coverage answer): the cards are the
//     1:1 inline-grounded excerpts the model was actually shown and cited ([Sn] each) → the
//     literal "Sources (N)" label and every card, unchanged.
//   - WHOLE-DOCUMENT (mode `tree`/`capped`/`extract`): the "citations" are LEAF PROVENANCE —
//     one entry per reachable document section (up to ~1000, uncapped server-side), NOT inline
//     grounding (the prompt carries no [Sn] markers; the model emits none). Presenting them as
//     "Sources (1000)" + 1000 cards reads as "the model cited 1000 passages" and janks. So a
//     provenance answer relabels to "Drawn from the document — N sections", drops the [Sn]
//     excerpt framing, marks the cards "Sections covered", and caps the render (~24 + an "and N
//     more sections" reveal). The CoverageMeter beside it owns the breadth claim (whole /
//     beginning / partial), so this label stays breadth-neutral and never restates it.

/** How many provenance cards to render before the "and N more sections" reveal. Exported:
 *  the evidence-review workspace (EP-1 plan §7.3) reuses the same cap for its source cards
 *  so the two surfaces can never disagree about "large provenance set" rendering. */
export const PROVENANCE_CARD_CAP = 24

/** One archive card's save progress; absent from the render = idle (the action is offered). */
type ArticleSaveState =
  | { phase: 'saving' }
  | { phase: 'saved'; result: PackArticleSaveResult }
  | { phase: 'failed'; message: string }

/**
 * The citation card's "Save to my documents" shortcut (#418, the second half of ruling C3;
 * `rag-design.md` §17 D-Z21, `design-guidelines.md` §11.15 "Tier-2 save action").
 *
 * State is PER CARD, deliberately: two cards can cite the same article (two chunks of it), and
 * the honest answer for the second one is the main side's own duplicate join — `findSavedArticle`
 * returns `alreadySaved: true` before any import runs, so the second card says "already in your
 * documents" instead of silently doing nothing. No renderer-side cross-card bookkeeping can say
 * that more truthfully, and the in-flight map main-side already collapses two overlapping
 * invokes for the same entry.
 *
 * The four states read exactly as the viewer's button does (§11.15): idle, saving (disabled, the
 * label swaps), saved / already saved (a `role="status"` line naming the filed title, with
 * nothing left to click) and failed (the action returns, enabled, with the main-side sentence
 * alone). The copy is the SAME five keys the viewer uses — one surface's wording cannot drift
 * from the other's, and there is no second German translation to keep in step.
 */
function ArchiveSaveAction({
  packId,
  articlePath,
  articleTitle,
  onSaveArticle,
  t
}: {
  packId: string
  articlePath: string
  /** The article's own title — the accessible name says WHICH article, per §11.15 decision 3. */
  articleTitle: string
  onSaveArticle: (packId: string, articlePath: string) => Promise<PackArticleSaveResult>
  t: I18n['t']
}): JSX.Element {
  const [state, setState] = useState<ArticleSaveState | null>(null)
  // A save that resolves after the turn left the tree must not set state on it. Assigned on
  // mount (not only cleared on unmount) so a StrictMode remount re-arms it.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function onSave(): Promise<void> {
    // A failed save is retryable (the viewer's rule); saving and saved are terminal for a click.
    if (state?.phase === 'saving' || state?.phase === 'saved') return
    setState({ phase: 'saving' })
    try {
      const result = await onSaveArticle(packId, articlePath)
      if (mounted.current) setState({ phase: 'saved', result })
    } catch (e) {
      if (mounted.current) setState({ phase: 'failed', message: friendlyIpcError(e) })
    }
  }

  if (state?.phase === 'saved') {
    return (
      <p className="hint source-card-save-state" role="status">
        {state.result.alreadySaved
          ? t('chat.article.alreadySaved', { title: state.result.title })
          : t('chat.article.saved', { title: state.result.title })}
      </p>
    )
  }
  return (
    <>
      <button
        type="button"
        className="source-card-save"
        disabled={state?.phase === 'saving'}
        // Visible label + ": {title}" — the accessible name distinguishes a repeated action in a
        // list (§11.15 decision 3) and the visible text stays its exact prefix (WCAG 2.5.3).
        aria-label={t('chat.article.saveAria', { title: articleTitle })}
        onClick={() => void onSave()}
      >
        {state?.phase === 'saving' ? t('chat.article.saving') : t('chat.article.save')}
      </button>
      {state?.phase === 'saving' && (
        <span className="hint source-card-save-state" role="status">
          <Spinner />
        </span>
      )}
      {state?.phase === 'failed' && (
        <p className="hint source-card-save-state">
          <span aria-hidden="true">⚠</span> {state.message}
        </p>
      )}
    </>
  )
}

export function SourcesDisclosure({
  citations,
  mode,
  onReview,
  reviewDisabled,
  onOpenArticle,
  onSaveArticle
}: {
  citations: Citation[]
  /** The answer's coverage mode; any whole-document mode (≠ relevance) renders as provenance. */
  mode?: CoverageMode
  /** EP-1 plan §7.2 (spec §9.2): the quiet "Review answer and sources" footer action at the
   *  bottom of the expanded region. Absent ⇒ never rendered (optional-callback gating). */
  onReview?: () => void
  /** Same streaming gate as the action row (`actionsDisabled` — review FIX-6): the footer
   *  entry must not open a review while a reply is streaming. */
  reviewDisabled?: boolean
  /** Knowledge packs (ZIM wave): opens the offline article viewer for an ARCHIVE citation.
   *  Absent ⇒ archive cards render read-only (optional-callback gating, like onReview). */
  onOpenArticle?: (citation: Citation) => void
  /**
   * #418 (ruling C3's second half): saves an ARCHIVE citation's article to the user's documents
   * straight from the card, without opening the viewer first. Takes the two IDS, not the
   * citation — the same pair `packs:saveArticle` carries, so the renderer's own boundary says
   * that nothing else about the citation is an input to the import (D-Z21).
   *
   * Absent ⇒ no save affordance at all (optional-callback gating, like `onOpenArticle`). That is
   * what keeps the shortcut out of read-only surfaces: an evidence review renders its source
   * cards from `EvidencePane`, which does not mount this component, and would still have to opt
   * in explicitly to get the action — the same boundary `ArticleModal`'s `canSave={false}` draws
   * for the viewer.
   */
  onSaveArticle?: (packId: string, articlePath: string) => Promise<PackArticleSaveResult>
}): JSX.Element {
  // tCount for the provenance labels (full-audit 2026-07-11 CODE-8): a one-section document
  // ("— 1 section") and a one-section reveal tail ("and 1 more section") are both reachable.
  const { t, tCount } = useT()
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const baseId = useId()
  const regionId = `${baseId}-region`
  // A whole-document answer's citations are leaf PROVENANCE, not 1:1 inline citations; only a
  // relevance answer (explicit, or undefined ⇒ pre-migration NULL coverage) keeps the literal
  // "Sources (N)" framing — so this path is byte-identical to before for every relevance turn.
  const isProvenance = mode != null && mode !== 'relevance'
  const overCap = isProvenance && !showAll && citations.length > PROVENANCE_CARD_CAP
  const shown = overCap ? citations.slice(0, PROVENANCE_CARD_CAP) : citations
  return (
    <div className="sources">
      <button
        type="button"
        className="sources-toggle"
        id={baseId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>{' '}
        {isProvenance
          ? tCount('chat.sources.wholeDoc', citations.length)
          : t('chat.sources.toggle', { count: citations.length })}
      </button>
      {open && (
        <div
          className={isProvenance ? 'sources-cards provenance' : 'sources-cards'}
          id={regionId}
          role="region"
          aria-labelledby={baseId}
        >
          {isProvenance && (
            <div className="sources-caption hint">{t('chat.sources.wholeDocCaption')}</div>
          )}
          {shown.map((c) => (
            <div key={c.label} className="source-card">
              <div className="source-card-head">
                {/* A relevance card's [Sn] is an inline citation the model emitted; a provenance
                    card is a SECTION the answer drew on, so it shows no [Sn] (would misread as a
                    1:1 citation). The marker is display-localized (EN [S1] / DE [Q1], D68); the
                    stored `c.label` stays the machine-stable `S{n}`. */}
                {!isProvenance && (
                  <span className="cite-label">[{formatCitationLabel(t, c.label)}]</span>
                )}
                <span className="source-card-title">{c.sourceTitle}</span>
                {c.pageNumber != null ? (
                  <span className="source-card-where">
                    {t('chat.sources.page', { page: c.pageNumber })}
                  </span>
                ) : c.sourceKind === 'archive' ? (
                  // An archive (knowledge-pack) citation names its pack alongside the section,
                  // so "Treibhausgas — Landwirtschaft" is attributed to the offline archive it
                  // came from, not mistaken for an imported document.
                  <span className="source-card-where">
                    {[c.archiveTitle, c.section].filter(Boolean).join(' · ')}
                  </span>
                ) : c.section ? (
                  <span className="source-card-where">{c.section}</span>
                ) : null}
                {c.sourceKind === 'archive' && c.packId && c.articlePath && onOpenArticle && (
                  <button
                    type="button"
                    className="source-card-open"
                    // #301 P6 (plan §9.23 (b)6): the visible text stays the bare "Open article"
                    // (it sits inside a card that already names its article), but an answer can
                    // carry several archive cards — so the ACCESSIBLE name carries the article
                    // title, and a screen reader's button list distinguishes them.
                    aria-label={t('chat.sources.openArticleNamed', { title: c.sourceTitle })}
                    onClick={() => onOpenArticle(c)}
                  >
                    {t('chat.sources.openArticle')}
                  </button>
                )}
                {/* #418: the save shortcut sits beside "Open article", the same quiet
                    link-styled affordance under the same guard — the pair is right-aligned by
                    `.source-card-open`'s `margin-left: auto`, and the save outcome takes the
                    next line of the wrapping head row so a filed title never squeezes the
                    citation's own title. */}
                {c.sourceKind === 'archive' && c.packId && c.articlePath && onSaveArticle && (
                  <ArchiveSaveAction
                    packId={c.packId}
                    articlePath={c.articlePath}
                    articleTitle={c.sourceTitle}
                    onSaveArticle={onSaveArticle}
                    t={t}
                  />
                )}
              </div>
              {c.snippet && <div className="source-card-snippet">{c.snippet}</div>}
            </div>
          ))}
          {overCap && (
            <button type="button" className="sources-more" onClick={() => setShowAll(true)}>
              {tCount('chat.sources.more', citations.length - PROVENANCE_CARD_CAP)}
            </button>
          )}
          {/* The quiet review entry (spec §9.2) — a footer action, deliberately styled like
              the reveal link above, never a loud button inside the disclosure. */}
          {onReview && (
            <button
              type="button"
              className="sources-review"
              disabled={reviewDisabled}
              onClick={onReview}
            >
              {t('review.entry.sources')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
