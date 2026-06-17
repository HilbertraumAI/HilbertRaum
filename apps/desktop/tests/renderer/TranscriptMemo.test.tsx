// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach, type Mock } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import Markdown from 'react-markdown'
import { Transcript } from '../../src/renderer/chat/Transcript'
import type { Message } from '../../src/shared/types'

// Perf audit FE-1: a ~40 ms streaming flush must NOT re-parse the Markdown of prior, unchanged
// messages, and the live answer must render as plain text (no per-flush Markdown parse of the
// growing buffer). We mock react-markdown so each parse is a countable call.

vi.mock('react-markdown', () => ({ default: vi.fn(({ children }) => <div data-testid="md">{children}</div>) }))
vi.mock('remark-gfm', () => ({ default: () => undefined }))

const mdMock = Markdown as unknown as Mock

function assistantMsg(content: string): Message {
  return { id: 'a1', conversationId: 'c1', role: 'assistant', content, createdAt: '2026-01-01T00:00:00Z' }
}

// Stable callbacks so MessageBlock's React.memo can hold across rerenders.
const noop = (): void => {}
const onCopy = (_c: string): void => {}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  mdMock.mockClear()
})

describe('Transcript — streaming memoization (FE-1)', () => {
  it('parses a persisted message once and renders the live answer as plain text (no Markdown parse)', () => {
    const messages = [assistantMsg('**Hello** world')]
    render(
      <Transcript
        messages={messages}
        streamingHere
        streamText="partial **answer**"
        streamThinking=""
        thinkingOpen={false}
        onThinkingOpenChange={noop}
        emptyState={null}
        onCopy={onCopy}
        onSave={noop}
        actionsDisabled={false}
      />
    )
    // Exactly ONE Markdown parse: the persisted assistant message. The live bubble is plain text,
    // so its growing buffer is never handed to react-markdown.
    expect(mdMock).toHaveBeenCalledTimes(1)
    // The raw streaming markers show literally (plain text), proving it bypassed Markdown.
    expect(screen.getByText(/partial \*\*answer\*\*/)).toBeInTheDocument()
  })

  it('does not re-parse prior messages when only streamText changes (the per-flush hot path)', () => {
    const messages = [assistantMsg('**Hello** world')]
    const props = {
      messages,
      streamingHere: true,
      streamThinking: '',
      thinkingOpen: false,
      onThinkingOpenChange: noop,
      emptyState: null,
      onCopy,
      onSave: noop,
      actionsDisabled: false
    }
    const { rerender } = render(<Transcript {...props} streamText="one" />)
    expect(mdMock).toHaveBeenCalledTimes(1)
    // A streaming flush: same messages array, new streamText. Prior message must not re-parse.
    rerender(<Transcript {...props} streamText="one two three" />)
    expect(mdMock).toHaveBeenCalledTimes(1)
    rerender(<Transcript {...props} streamText="one two three four five" />)
    expect(mdMock).toHaveBeenCalledTimes(1)
  })
})
