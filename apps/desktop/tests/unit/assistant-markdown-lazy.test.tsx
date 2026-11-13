// @vitest-environment jsdom
import { describe, it, expect, afterEach, onTestFinished, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
// Import the REAL lazy wrapper by full path. `vitest.config.ts` aliases the two specifiers the app
// imports it by ('./AssistantMarkdownLazy' and '../chat/AssistantMarkdownLazy') → the synchronous
// component so every OTHER render test skips Suspense; this longer path does NOT match that alias,
// so here we exercise the shipped React.lazy + dynamic-import + Suspense glue that the renderer
// code-split (PR #33) actually ships. The direct component is imported too, only to prove the alias
// was bypassed.
import { AssistantMarkdown as LazyWrapper } from '../../src/renderer/chat/AssistantMarkdownLazy'
import { AssistantMarkdown as DirectRenderer } from '../../src/renderer/chat/AssistantMarkdown'
import { t } from '../../src/shared/i18n'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeItem, stubReviewApi } from '../helpers/evidenceReview'

afterEach(cleanup)

describe('AssistantMarkdownLazy (renderer code-split wrapper)', () => {
  it('is a distinct lazy wrapper, not the aliased synchronous component', () => {
    // Guard: if the alias had caught this test's import, both specifiers would resolve to the
    // same component and this fails — proving the tests below genuinely drive the async chunk
    // path rather than the synchronous stand-in.
    expect(LazyWrapper).not.toBe(DirectRenderer)
  })

  it('lazy-loads the Streamdown renderer and typesets markdown', async () => {
    // End-to-end: import('./AssistantMarkdown') resolves, `m.AssistantMarkdown` maps to the
    // lazy default, Suspense swaps it in, and it typesets like the direct component
    // (**bold** → <strong>). A wrong export name or broken barrel would fail right here.
    render(<LazyWrapper text={'hello **bold** world'} />)
    const strong = await screen.findByText('bold')
    expect(strong.tagName).toBe('STRONG')
  })

  it('forwards the streaming prop through to the underlying renderer', async () => {
    // The wrapper passes { text, streaming } through unchanged. An unclosed trailing \( … only
    // typesets when streaming=true reaches Streamdown's remend handler, so a .katex node here
    // proves the prop is not dropped by the wrapper.
    const { container } = render(<LazyWrapper text={'Einstein: \\( E = mc^2'} streaming />)
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull())
  })

  it('the alias reaches ReviewScreen too: a review item is never shown as raw markdown (#815)', async () => {
    // The guard above's other side. ReviewScreen imports '../chat/AssistantMarkdownLazy'; with the
    // alias it gets the synchronous component, so the review suites test the screen without the
    // lazy chunk. Through the real wrapper React first commits the Suspense fallback (the raw text,
    // asterisks included) and replaces it once the chunk loads — which can happen inside the same
    // act() flush that `findBy` waits in, so the end state can't tell the two apart. The row
    // records every node React adds or removes while the screen loads instead: a fallback that
    // reached the DOM shows up there even after it was replaced. A fresh module graph, because
    // React.lazy caches a loaded chunk per graph (a cached one renders with no fallback at all)
    // and the rows above load it through the file the old alias resolved ReviewScreen's
    // specifier to.
    vi.resetModules()
    const [{ ReviewScreen }, session] = await Promise.all([
      import('../../src/renderer/screens/ReviewScreen'),
      import('../../src/renderer/lib/reviewSession')
    ])
    onTestFinished(() => session.purgeReviewSession())
    stubReviewApi({
      getEvidenceReview: vi.fn(async () =>
        makeDetail({ items: [makeItem({ id: 'i1', ordinal: 0, textSnapshot: 'Alpha **bold** text' })] })
      )
    })
    const shown: string[] = []
    const record = (records: MutationRecord[]): void => {
      for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) shown.push(n.textContent ?? '')
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, { childList: true, subtree: true })
    onTestFinished(() => observer.disconnect())
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={() => {}} />)

    const item = await screen.findByRole('listitem', { name: t('en', 'review.item.aria', { n: 1 }) })
    record(observer.takeRecords())
    expect(shown.filter((text) => text.includes('**bold**'))).toEqual([])
    expect(within(item).getByText('bold').tagName).toBe('STRONG')
    assertNoUnexpectedApiCalls()
  })
})
