// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AnswerThread, type ImageTurn } from '../../src/renderer/images'
import { t, type MessageKey } from '../../src/shared/i18n'
import type { VisionErrorCode } from '../../src/shared/types'

// The image answer is rendered through the SAME markdown renderer as Chat/Documents
// (AssistantMarkdown). This pins the formatting fix: bold/lists render as real elements, never
// as literal "**" / "1." text.

afterEach(cleanup)

const noop = (): void => {}

function renderThread(
  answer: string,
  state: ImageTurn['state'] = 'done',
  error: VisionErrorCode | null = null
): void {
  const turn: ImageTurn = { id: 't1', question: 'What is in this image?', answer, state, error }
  render(<AnswerThread turns={[turn]} onCopy={noop} onTryAgain={noop} onStop={noop} busy={false} />)
}

describe('AnswerThread — markdown rendering', () => {
  it("renders a settled answer's markdown (bold + ordered list) as elements, not literal syntax", () => {
    renderThread('A **bold** finding.\n\n1. First\n2. Second')
    const strong = screen.getByText('bold')
    expect(strong.tagName).toBe('STRONG')
    // The literal "**bold**" must NOT appear anywhere.
    expect(screen.queryByText(/\*\*bold\*\*/)).not.toBeInTheDocument()
    // The list items carry no literal "1." / "2.".
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['First', 'Second'])
  })

  // PERF-6: while a turn is IN FLIGHT (starting/analyzing) the streaming answer renders as PLAIN
  // TEXT — Markdown is parsed once, on completion. So an analyzing turn shows the LITERAL "**bold**"
  // and produces NO <strong>; the DONE test above proves the parse-on-completion still works.
  it('renders an in-flight (analyzing) answer as plain text, not parsed markdown (PERF-6)', () => {
    renderThread('A **bold** finding.', 'analyzing')
    expect(document.body.textContent).toContain('**bold**')
    expect(document.querySelector('strong')).toBeNull()
  })
})

// A failed turn shows friendly copy for its code — never raw runtime output. Main sends a code on the
// error event (`fail()`), including `emptyResponse` for an empty answer. An UNKNOWN code (a newer main)
// must fall back to the runtimeFailed copy: data-contracts.md says renderers MUST keep that fallback
// (#123), it is what makes adding codes main-side skew-safe. `engineCannotRun` is EngineProblem.test.tsx's.
describe('AnswerThread — a failed turn names what went wrong', () => {
  // The one deliberate non-member of the union: a code this renderer does not know yet.
  const newerCode: string = 'aCodeFromANewerMain'
  const FROM_A_NEWER_MAIN = newerCode as VisionErrorCode

  it.each<[VisionErrorCode, MessageKey]>([
    ['runtimeFailed', 'images.err.runtimeFailed'],
    ['emptyResponse', 'images.err.emptyResponse'],
    ['emptyQuestion', 'images.err.emptyQuestion'],
    ['timedOut', 'images.err.timedOut'],
    ['contextExceeded', 'images.err.contextExceeded'],
    [FROM_A_NEWER_MAIN, 'images.err.runtimeFailed']
  ])('a failed turn with code %s shows %s (unknown codes fall back, #123)', (code, key) => {
    renderThread('', 'failed', code)
    expect(screen.getByText(t('en', key))).toBeInTheDocument()
  })
})
