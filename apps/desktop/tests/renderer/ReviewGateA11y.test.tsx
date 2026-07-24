// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { EvidencePane } from '../../src/renderer/review/EvidencePane'
import { ReviewSummaryView } from '../../src/renderer/review/ReviewSummaryView'
import { PROVENANCE_CARD_CAP } from '../../src/renderer/chat/SourcesDisclosure'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import {
  t,
  tCount,
  type CountMessageKey,
  type MessageKey,
  type MessageParams,
  type UiLanguage
} from '../../src/shared/i18n'
import type { EvidenceSourceSnapshot } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeFreshness, stubReviewApi } from '../helpers/evidenceReview'

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

beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

beforeEach(() => {
  resetReviewSessionForTests()
})

afterEach(() => {
  cleanup()
  assertNoUnexpectedApiCalls()
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
  let narrow = true
  let listeners: Set<() => void>

  beforeEach(() => {
    narrow = true
    listeners = new Set()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        get matches() {
          return narrow
        },
        media: query,
        addEventListener: (_event: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_event: string, fn: () => void) => listeners.delete(fn),
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false
      })
    })
  })

  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  /** Resize the window across the drawer breakpoint, the way the media query reports it. */
  function setNarrow(next: boolean): void {
    act(() => {
      narrow = next
      for (const fn of [...listeners]) fn()
    })
  }

  it('widening the window closes the drawer for good — narrowing again does not re-open it', async () => {
    stubReviewApi({ getEvidenceReview: vi.fn(async () => makeDetail()) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    const items = screen.getAllByRole('listitem')
    fireEvent.click(
      within(items[0]!).getByRole('button', { name: t('en', 'review.item.viewEvidence') })
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(t('en', 'review.disclaimer'))).toBeInTheDocument()

    // Wide again (the user un-snaps the window): the drawer is gone and the evidence pane
    // is back inline.
    setNarrow(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.querySelector('.review-evidence-pane')).not.toBeNull()

    // Narrow again — a Windows snap is enough. Nothing was clicked, so nothing may open:
    // a drawer appearing here is a modal focus trap the user never asked for.
    setNarrow(true)
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

describe('evidence-pane reveal control counts SOURCES (AUD-11)', () => {
  function makeSources(n: number): EvidenceSourceSnapshot[] {
    const base = makeDetail().sources[0]!
    return Array.from({ length: n }, (_, i) => ({
      ...base,
      key: `s${i + 1}`,
      machineLabel: `S${i + 1}`,
      documentTitle: `doc-${i + 1}.pdf`,
      snippet: `Snippet number ${i + 1}`
    }))
  }

  function renderPane(lang: UiLanguage): void {
    const l = bound(lang)
    render(
      <EvidencePane
        sources={makeSources(60)}
        coverage={{ mode: 'relevance', chunksCovered: 2, chunksTotal: 9 }}
        selectedItem={null}
        readOnly={false}
        freshness={null}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
        onSetRelation={vi.fn()}
        t={l.t}
        tCount={l.tCount}
      />
    )
  }

  it.each([['en'], ['de']] as Array<[UiLanguage]>)(
    'the reveal button and the count line agree about the noun (%s)',
    (lang) => {
      renderPane(lang)
      const reveal = document.querySelector('.sources-more')
      expect(reveal?.textContent).toBe(tCount(lang, 'review.evidence.more', PROVENANCE_CARD_CAP))
      // The line directly above it says "sources"; the button used to say "sections",
      // borrowed from the chat's whole-document copy.
      expect(reveal?.textContent).not.toBe(tCount(lang, 'chat.sources.more', PROVENANCE_CARD_CAP))
      expect(
        screen.getByText(
          t(lang, 'review.evidence.shownCount', { shown: PROVENANCE_CARD_CAP, total: 60 })
        )
      ).toBeInTheDocument()
    }
  )

  it('the final batch declines the singular correctly in both languages', () => {
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
