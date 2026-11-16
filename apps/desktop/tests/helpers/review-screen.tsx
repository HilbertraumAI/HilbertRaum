import type { ComponentProps } from 'react'
import { fireEvent, render, screen, within, type RenderResult } from '@testing-library/react'
import { vi } from 'vitest'
import type { PreloadApi } from '../../src/preload'
import type { ReviewHandoffTarget } from '../../src/renderer/lib/reviewSession'
import { EvidencePane } from '../../src/renderer/review/EvidencePane'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { t, tCount, type UiLanguage } from '../../src/shared/i18n'
import type { EvidenceReviewDetail, EvidenceReviewFreshness } from '../../src/shared/types'
import { makeDetail, stubReviewApi } from './evidenceReview'
import { renderInLanguage } from './render-language'

// The review-workspace harness (review + export test campaign, commit H; the chat-screen.tsx / home-screen.tsx pattern).
// Replaces what the review suites each wrote inline at 27bd0b0d: the `stubReviewApi({ getEvidenceReview: … })` +
// `render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)` + `await screen.findByText('Beta')` mount
// (~24x ReviewScreen.test.tsx, 15x ReviewExport.test.tsx, 8x ReviewSelections.test.tsx, ReviewGateA11y.test.tsx,
// ReviewItemMemo.test.tsx), the summary/export-panel openers, and the `<EvidencePane …11 props…>` renders with their
// language shims (ReviewEvidencePane.test.tsx, ReviewGateA11y.test.tsx).
//
// Rules:
//  - `renderReview` installs its stubs through `stubReviewApi` (one install per call, fresh bookkeeping), so a suite's
//    `assertNoUnexpectedApiCalls()` sees every stub it runs against. Pass everything the row drives in `api`.
//  - The suite still owns teardown: `purgeReviewSession()` before each test, `cleanup()` then the no-call check after,
//    and `window.localStorage.clear()` when it passes `lang` (`renderInLanguage` sets the mirror).

function noop(): void {}

/**
 * Mount ReviewScreen on `detail` (default `makeDetail()`) and wait until the opened review has rendered (its footer
 * Summary button). Stubs: `getEvidenceReview` resolving `detail`, the freshness auto-stub (`fresh`, default
 * `makeFreshness()` for the review), then `api` (wins). `handoff` defaults to `{ reviewId: detail.id }`; `props`
 * spreads last onto the screen (`onNavigate` defaults to a no-op). `lang` renders under `I18nProvider` in that
 * language. A row about the loading or not-found state renders ReviewScreen itself: this waits for a loaded review.
 * Replaces the inline mounts at 27bd0b0d, e.g. ReviewScreen.test.tsx:148-153 and ReviewExport.test.tsx:62-63.
 */
export async function renderReview(
  opts: {
    detail?: EvidenceReviewDetail
    api?: Partial<PreloadApi>
    fresh?: EvidenceReviewFreshness
    handoff?: ReviewHandoffTarget
    props?: Partial<ComponentProps<typeof ReviewScreen>>
    lang?: UiLanguage
  } = {}
): Promise<{ refresh: ReturnType<typeof stubReviewApi>['refresh']; view: RenderResult }> {
  const detail = opts.detail ?? makeDetail()
  const { refresh } = stubReviewApi(
    { getEvidenceReview: vi.fn<PreloadApi['getEvidenceReview']>(async () => detail), ...opts.api },
    opts.fresh
  )
  const ui = <ReviewScreen handoff={opts.handoff ?? { reviewId: detail.id }} onNavigate={noop} {...opts.props} />
  const view = opts.lang ? renderInLanguage(ui, opts.lang) : render(ui)
  await screen.findByRole('button', { name: t(opts.lang ?? 'en', 'review.footer.summary') })
  return { refresh, view }
}

/**
 * Open the review summary from the footer and resolve its dialog. `findByRole` waits for the open-session load (the
 * footer renders only once the detail is in the store). Replaces ReviewExport.test.tsx:48 (`openSummary`) and the
 * inline `fireEvent.click(footer summary)` + `findByRole('dialog')` pairs in ReviewScreen.test.tsx (e.g. :110-111).
 */
export async function openSummary(lang: UiLanguage = 'en'): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: t(lang, 'review.footer.summary') }))
  return await screen.findByRole('dialog')
}

/** Open the summary's export panel and wait for its §24.3 encryption warning. Replaces ReviewExport.test.tsx:55. */
export async function openExportPanel(dialog: HTMLElement, lang: UiLanguage = 'en'): Promise<void> {
  fireEvent.click(within(dialog).getByRole('button', { name: t(lang, 'review.export.action') }))
  await within(dialog).findByText(t(lang, 'review.export.encryptionWarning'))
}

/**
 * Render the pure EvidencePane (no `window.api`, no provider) with `t` / `tCount` bound to `lang`: `makeDetail()`'s
 * sources, a relevance coverage of 2/9, nothing selected, editable, no freshness verdict, `vi.fn()` link handlers, and
 * NO `onOpenContext` / `onOpenArticle` (their buttons are callback-gated: pass one to get it). `props` spreads last.
 * Replaces at 27bd0b0d: ReviewEvidencePane.test.tsx:41 (`renderPane`), :309 (`renderArchive`), the five inline
 * renders there (:162, :202, :242, :266, :372) with the `tEn` / `tCountEn` / `tDe` / `tCountDe` shims (:26), and
 * ReviewGateA11y.test.tsx:161 (`renderPane`) with its `bound(lang)` shim (:45).
 */
export function renderEvidencePane(
  props: Partial<ComponentProps<typeof EvidencePane>> = {},
  lang: UiLanguage = 'en'
): RenderResult {
  return render(
    <EvidencePane
      sources={makeDetail().sources}
      coverage={{ mode: 'relevance', chunksCovered: 2, chunksTotal: 9 }}
      selectedItem={null}
      readOnly={false}
      freshness={null}
      onLink={vi.fn()}
      onUnlink={vi.fn()}
      onSetRelation={vi.fn()}
      t={(key, params) => t(lang, key, params)}
      tCount={(key, count, params) => tCount(lang, key, count, params)}
      {...props}
    />
  )
}
