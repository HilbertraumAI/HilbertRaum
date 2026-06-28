// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AnswerThread, type ImageTurn } from '../../src/renderer/images'

// The image answer is rendered through the SAME markdown renderer as Chat/Documents
// (AssistantMarkdown). This pins the formatting fix: bold/lists render as real elements, never
// as literal "**" / "1." text.

afterEach(cleanup)

const noop = (): void => {}

function renderThread(answer: string, state: ImageTurn['state'] = 'done'): void {
  const turn: ImageTurn = { id: 't1', question: 'What is in this image?', answer, state, error: null }
  render(<AnswerThread turns={[turn]} onCopy={noop} onTryAgain={noop} onStop={noop} />)
}

describe('AnswerThread — markdown rendering', () => {
  it('renders bold markdown as <strong>, not literal asterisks', () => {
    renderThread('A **bold** finding.')
    const strong = screen.getByText('bold')
    expect(strong.tagName).toBe('STRONG')
    // The literal "**bold**" must NOT appear anywhere.
    expect(screen.queryByText(/\*\*bold\*\*/)).not.toBeInTheDocument()
  })

  it('renders an ordered list as <li> items', () => {
    renderThread('1. First\n2. Second')
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['First', 'Second'])
  })

  // PERF-6: while a turn is IN FLIGHT (starting/analyzing) the streaming answer renders as PLAIN
  // TEXT — Markdown is parsed once, on completion. So an analyzing turn shows the LITERAL "**bold**"
  // and produces NO <strong>; the DONE tests above prove the parse-on-completion still works.
  it('renders an in-flight (analyzing) answer as plain text, not parsed markdown (PERF-6)', () => {
    renderThread('A **bold** finding.', 'analyzing')
    expect(document.body.textContent).toContain('**bold**')
    expect(document.querySelector('strong')).toBeNull()
  })
})
