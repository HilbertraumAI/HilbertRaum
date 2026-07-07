// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
// Import the REAL lazy wrapper by full path. `vitest.config.ts` aliases the bare specifier
// './AssistantMarkdownLazy' → the synchronous component so every OTHER render test skips
// Suspense; this longer path does NOT match that alias, so here we exercise the shipped
// React.lazy + dynamic-import + Suspense glue that the renderer code-split (PR #33) actually
// ships. The direct component is imported too, only to prove the alias was bypassed.
import { AssistantMarkdown as LazyWrapper } from '../../src/renderer/chat/AssistantMarkdownLazy'
import { AssistantMarkdown as DirectRenderer } from '../../src/renderer/chat/AssistantMarkdown'

afterEach(cleanup)

describe('AssistantMarkdownLazy (renderer code-split wrapper)', () => {
  it('is a distinct lazy wrapper, not the aliased synchronous component', () => {
    // Guard: if the './AssistantMarkdownLazy' alias had caught this test's import, both
    // specifiers would resolve to the same component and this fails — proving the tests below
    // genuinely drive the async chunk path rather than the synchronous stand-in.
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
})
