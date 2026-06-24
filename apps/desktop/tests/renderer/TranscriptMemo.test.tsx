// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach, type Mock } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { Streamdown } from 'streamdown'
import { Transcript } from '../../src/renderer/chat/Transcript'
import type { Message } from '../../src/shared/types'

// Perf audit FE-1 (revisited): the live answer now renders Markdown via Streamdown (its block
// memoization keeps the per-flush cost to the final block), but a ~40 ms streaming flush must STILL
// NOT re-parse the Markdown of prior, unchanged messages. We mock Streamdown so each parse is a
// countable call tagged by the text it received, and assert the persisted turn parses exactly once
// across flushes while the live bubble is the thing that re-renders.

vi.mock('streamdown', () => ({
  Streamdown: vi.fn(({ children }) => <div data-testid="sd">{children}</div>),
  // Module-load reads `.raw`/`.sanitize` off this; any truthy plugin values suffice for the mock.
  defaultRehypePlugins: { raw: () => undefined, sanitize: () => undefined }
}))

const sdMock = Streamdown as unknown as Mock
const persistedParses = (text: string): number =>
  sdMock.mock.calls.filter((c) => (c[0] as { children?: unknown }).children === text).length

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
  sdMock.mockClear()
})

describe('Transcript — streaming memoization (FE-1)', () => {
  it('renders the live answer as Markdown (Streamdown), and parses the persisted turn once', () => {
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
    // Two parses: the persisted assistant message AND the live bubble — the live answer now goes
    // THROUGH Streamdown (Markdown), no longer rendered as raw plain text.
    expect(persistedParses('**Hello** world')).toBe(1)
    const liveParsed = sdMock.mock.calls.some((c) =>
      String((c[0] as { children?: unknown }).children).includes('partial **answer**')
    )
    expect(liveParsed).toBe(true)
    expect(screen.getAllByTestId('sd').length).toBe(2)
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
    expect(persistedParses('**Hello** world')).toBe(1)
    // A streaming flush: same messages array, new streamText. The persisted turn must not re-parse.
    rerender(<Transcript {...props} streamText="one two three" />)
    expect(persistedParses('**Hello** world')).toBe(1)
    rerender(<Transcript {...props} streamText="one two three four five" />)
    expect(persistedParses('**Hello** world')).toBe(1)
  })
})
