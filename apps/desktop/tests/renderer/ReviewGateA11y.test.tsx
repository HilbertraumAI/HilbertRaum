// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { ReviewSummaryView } from '../../src/renderer/review/ReviewSummaryView'
import { purgeReviewSession } from '../../src/renderer/lib/reviewSession'
import {
  t,
  tCount,
  type CountMessageKey,
  type MessageKey,
  type MessageParams,
  type UiLanguage
} from '../../src/shared/i18n'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { makeDetail, makeFreshness } from '../helpers/evidenceReview'
import { fakeMatchMedia, removeMatchMedia, type MatchMediaFake } from '../helpers/match-media'
import { renderReview } from '../helpers/review-screen'

// Presentation-state and copy defects on the review surface — none of them can move data,
// all of them mislead the person doing the reviewing:
//
//  - AUD-09: the export toggle keeps announcing "expanded" after the freshness gate hides
//    the panel underneath it, and re-enabling the control pops the panel back open.
//  - AUD-10: the narrow-window evidence drawer is never closed when the window is widened,
//    so the next narrowing re-opens it — unasked — inside a focus trap.
//  - AUD-11: the "reveal more" control under the source cards counted "sections".
//
// The three sit together because they share one shape: state that describes the UI is left
// behind when the condition that produced it goes away.

beforeEach(() => {
  purgeReviewSession()
})

afterEach(() => {
  try {
    cleanup()
  } finally {
    assertNoUnexpectedApiCalls()
  }
})

function noop(): void {}

const bound = (
  lang: UiLanguage
): { t: (k: MessageKey, p?: MessageParams) => string; tCount: (k: CountMessageKey, n: number, p?: MessageParams) => string } => ({
  t: (key, params) => t(lang, key, params),
  tCount: (key, count, params) => tCount(lang, key, count, params)
})

describe('summary export toggle — disclosure state follows the gate (AUD-09)', () => {
  /** The freshness verdict arrives asynchronously, so a summary can be interacted with
   *  while `freshness` is still null; re-rendering with the landed verdict is exactly that
   *  sequence. */
  function renderSummary(freshness: Parameters<typeof ReviewSummaryView>[0]['freshness']) {
    const en = bound('en')
    return (
      <ReviewSummaryView
        detail={makeDetail()}
        freshness={freshness}
        onEditHead={noop}
        onMarkReady={noop}
        onReopen={noop}
        onAcknowledge={noop}
        busy={false}
        t={en.t}
        tCount={en.tCount}
        lang="en"
      />
    )
  }

  it('an outdated verdict landing on an OPEN panel resets aria-expanded and never re-opens it', () => {
    // #832: the file's first row runs with no window.api at all, so an optional-chained call would pass silently.
    stubApi({})
    const { rerender } = render(renderSummary(null))
    const toggle = screen.getByRole('button', { name: t('en', 'review.export.action') })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // No verdict yet ⇒ the gate is not engaged ⇒ the panel opens normally.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(t('en', 'review.export.encryptionWarning'))).toBeInTheDocument()

    // The verdict lands: outdated and not acknowledged ⇒ export is gated (§28.6).
    rerender(renderSummary(makeFreshness({ outdated: true, acknowledgedAt: null })))
    expect(screen.queryByText(t('en', 'review.export.encryptionWarning'))).toBeNull()
    expect(toggle).toBeDisabled()
    // A disabled control that announces "expanded" over a panel that is not there tells a
    // screen-reader user something false about the screen.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Acknowledging the drift re-enables the control — it must NOT spring open by itself.
    rerender(renderSummary(makeFreshness({ outdated: true, acknowledgedAt: '2026-07-19T09:00:00.000Z' })))
    expect(toggle).not.toBeDisabled()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(t('en', 'review.export.encryptionWarning'))).toBeNull()

    // …and it still works when the user does ask for it.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(t('en', 'review.export.encryptionWarning'))).toBeInTheDocument()
  })
})

describe('narrow-window evidence drawer — closed on leaving narrow mode (AUD-10)', () => {
  let viewport: MatchMediaFake

  beforeEach(() => {
    viewport = fakeMatchMedia(true)
  })

  afterEach(() => {
    removeMatchMedia()
  })

  it('widening the window closes the drawer for good — narrowing again does not re-open it', async () => {
    await renderReview({ detail: makeDetail() })
    await screen.findByText('Beta')

    const items = screen.getAllByRole('listitem')
    fireEvent.click(
      within(items[0]!).getByRole('button', { name: t('en', 'review.item.viewEvidence') })
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(t('en', 'review.disclaimer'))).toBeInTheDocument()

    // Wide again (the user un-snaps the window): the drawer is gone and the evidence pane
    // is back inline.
    viewport.set(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.querySelector('.review-evidence-pane')).not.toBeNull()

    // Narrow again — a Windows snap is enough. Nothing was clicked, so nothing may open:
    // a drawer appearing here is a modal focus trap the user never asked for.
    viewport.set(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.review-evidence-pane')).toBeNull()

    // The drawer still opens on request afterwards.
    const narrowItems = screen.getAllByRole('listitem')
    fireEvent.click(
      within(narrowItems[0]!).getByRole('button', { name: t('en', 'review.item.viewEvidence') })
    )
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})

// The reveal button's accessible name is pinned on a 60-source pane by ReviewEvidencePane.test.tsx ("large sets: …");
// the row below pins the copy itself, literally, in both languages.
describe('evidence-pane reveal control counts SOURCES (AUD-11)', () => {
  it('the final batch declines the singular correctly in both languages', () => {
    // #832: reset the bookkeeping the screen row above leaves behind (stubApi is the only reset).
    stubApi({})
    for (const lang of ['en', 'de'] as UiLanguage[]) {
      expect(tCount(lang, 'review.evidence.more', 1)).not.toBe(
        tCount(lang, 'review.evidence.more', 2)
      )
    }
    expect(tCount('en', 'review.evidence.more', 1)).toBe('and 1 more source')
    expect(tCount('en', 'review.evidence.more', 2)).toBe('and 2 more sources')
    expect(tCount('de', 'review.evidence.more', 1)).toBe('und 1 weitere Quelle')
    expect(tCount('de', 'review.evidence.more', 2)).toBe('und 2 weitere Quellen')
  })
})
