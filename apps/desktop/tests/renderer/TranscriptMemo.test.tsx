// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Streamdown } from 'streamdown'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { makeMessage } from '../helpers/chat-fixtures'
import { transcriptProps } from '../helpers/transcript'

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
/** How many times Streamdown was handed exactly `text` (a persisted turn or a live flush). */
const parses = (text: string): number =>
  sdMock.mock.calls.filter((c) => (c[0] as { children?: unknown }).children === text).length

afterEach(() => {
  cleanup()
  sdMock.mockClear()
})

// transcriptProps' handlers are module-level, so every render below gets the same function objects
// and MessageBlock's React.memo can hold across rerenders.
describe('Transcript — streaming memoization (FE-1)', () => {
  it('does not re-parse prior messages when only streamText changes (the per-flush hot path)', () => {
    const props = transcriptProps({ messages: [makeMessage({ content: '**Hello** world' })], streamingHere: true })
    const { rerender } = render(<Transcript {...props} streamText="one" />)
    expect(parses('**Hello** world')).toBe(1)
    expect(parses('one'), 'the live answer goes through Streamdown (FE-1 revisited)').toBe(1)
    // A streaming flush: same messages array, new streamText. The persisted turn must not re-parse.
    rerender(<Transcript {...props} streamText="one two three" />)
    expect(parses('one two three'), 'positive control: the counter sees the flush').toBe(1)
    expect(parses('**Hello** world')).toBe(1)
    rerender(<Transcript {...props} streamText="one two three four five" />)
    expect(parses('**Hello** world')).toBe(1)
  })

  it('hands Streamdown the same objects on every flush; only the text changes (#685)', () => {
    // Streamdown memoizes its blocks on these props and puts some of them (linkSafety among them)
    // into the context its code blocks, tables and images read: one fresh object per flush
    // re-renders those inside every block already closed. `linkSafety` was such an inline object.
    const props = transcriptProps({ streamingHere: true })
    const { rerender } = render(<Transcript {...props} streamText="Erster Teil" />)
    rerender(<Transcript {...props} streamText="Erster Teil, zweiter Teil" />)
    const [first, last] = [sdMock.mock.calls[0]![0], sdMock.mock.calls.at(-1)![0]] as Record<string, unknown>[]
    expect(last!.children).not.toBe(first!.children)
    const objectProps = Object.keys(first!).filter(
      (k) => k !== 'children' && first![k] !== null && ['object', 'function'].includes(typeof first![k])
    )
    expect(objectProps).toEqual(expect.arrayContaining(['linkSafety', 'components', 'plugins', 'remend']))
    expect(objectProps.filter((k) => last![k] !== first![k])).toEqual([])
  })
})
