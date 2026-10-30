// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConversationList, groupConversations, splitSnippet } from '../../src/renderer/chat/ConversationList'
import { t } from '../../src/shared/i18n'
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type Conversation,
  type ConversationSearchResult
} from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { makeConversation } from '../helpers/chat-fixtures'

// The conversation list's pure helpers (`splitSnippet`, `groupConversations`) and, Phase 31, its
// search box: typing swaps the column to full-text results (matched terms highlighted via the
// SEARCH_MARK markers, never HTML), picking a result opens its conversation, and the friendly
// no-matches copy (spec §11.4).

function result(over: Partial<ConversationSearchResult> = {}): ConversationSearchResult {
  return {
    conversationId: 'c1',
    conversationTitle: 'Contract questions',
    hits: [
      {
        messageId: 'm1',
        role: 'assistant',
        snippet: `the ${SEARCH_MARK_START}liability${SEARCH_MARK_END} cap is two million…`,
        createdAt: '2026-01-01T00:00:00Z'
      }
    ],
    ...over
  }
}

function renderList(
  conversations: Conversation[],
  onSelect: (c: Conversation) => void = () => {}
): void {
  render(
    <ConversationList
      conversations={conversations}
      activeId={null}
      streaming={false}
      mode="chat"
      onSelect={onSelect}
      onNew={() => {}}
      onDelete={() => {}}
      onCollapse={() => {}}
    />
  )
}

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

describe('splitSnippet', () => {
  it('splits marker-wrapped matches out of the plain text', () => {
    const parts = splitSnippet(`a ${SEARCH_MARK_START}hit${SEARCH_MARK_END} b`)
    expect(parts).toEqual([
      { text: 'a ', match: false },
      { text: 'hit', match: true },
      { text: ' b', match: false }
    ])
  })

  it('handles marker-less text and an unterminated marker defensively', () => {
    expect(splitSnippet('plain text')).toEqual([{ text: 'plain text', match: false }])
    expect(splitSnippet(`x ${SEARCH_MARK_START}dangling`)).toEqual([
      { text: 'x ', match: false },
      { text: 'dangling', match: false }
    ])
  })
})

describe('groupConversations — date grouping', () => {
  it('buckets by recency relative to "now" and drops empty groups', () => {
    const now = new Date('2026-06-10T12:00:00')
    const c = (id: string, updatedAt: string) => makeConversation({ id, title: id, updatedAt })
    const groups = groupConversations(
      [
        c('today', '2026-06-10T08:00:00'),
        c('yesterday', '2026-06-09T23:00:00'),
        c('thisweek', '2026-06-05T10:00:00'),
        c('old', '2026-01-01T00:00:00'),
        c('junk', 'not-a-date')
      ],
      now
    )
    expect(groups.map((g) => [t('en', g.labelKey), g.conversations.map((x) => x.id)])).toEqual([
      ['Today', ['today']],
      ['Yesterday', ['yesterday']],
      ['Last 7 days', ['thisweek']],
      ['Earlier', ['old', 'junk']]
    ])
  })
})

describe('ConversationList — search (Phase 31)', () => {
  it('typing searches and shows highlighted results; picking one opens the conversation', async () => {
    vi.useFakeTimers()
    const c = makeConversation({ title: 'Contract questions' })
    const onSelect = vi.fn()
    const searchConversations = vi.fn(async () => [result()])
    stubApi({ searchConversations })
    renderList([c], onSelect)

    // Type "liability" one key at a time with NO time passing between keys (fake timers): each
    // zero-time hop runs whatever is already due, so a per-keystroke or zero-delay search would
    // fire here. (Keys go in as change events: RTL's user-event wrapper drains on a real-clock
    // setTimeout, which never fires under vitest's fake timers.)
    const box = screen.getByRole('searchbox', { name: 'Search conversations' })
    const query = 'liability'
    for (let i = 1; i <= query.length; i++) {
      fireEvent.change(box, { target: { value: query.slice(0, i) } })
      await act(() => vi.advanceTimersByTimeAsync(0))
    }
    // Debounced: one IPC call for the finished query, not one per keystroke (T-3, #147).
    expect(searchConversations).not.toHaveBeenCalled()
    await act(async () => {
      await vi.runOnlyPendingTimersAsync() // the one pending debounce elapses
    })
    expect(searchConversations).toHaveBeenCalledTimes(1)
    expect(searchConversations).toHaveBeenCalledWith('liability')
    const row = screen.getByRole('button', { name: /Contract questions/ })
    // The matched term renders as <mark>, the rest as plain text.
    expect(screen.getByText('liability').tagName).toBe('MARK')
    expect(row.textContent).toContain('the liability cap is two million')

    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith(c)
    // Picking a result clears the search and returns to the normal grouped list.
    expect(box).toHaveValue('')
  })

  // L14: the results region is a polite live region and carries an sr-only result count.
  it('announces the result region with an sr-only count (L14)', async () => {
    const user = userEvent.setup()
    stubApi({ searchConversations: vi.fn(async () => [result(), result({ conversationId: 'c2' })]) })
    renderList([makeConversation({ title: 'Contract questions' })])

    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'liability')
    const region = await screen.findByRole('region', { name: 'Search results' })
    expect(region).toHaveAttribute('aria-live', 'polite')
    await waitFor(() => expect(screen.getByText('2 results')).toBeInTheDocument())
  })

  it('shows friendly copy when nothing matches', async () => {
    const user = userEvent.setup()
    stubApi({ searchConversations: vi.fn(async () => []) })
    renderList([makeConversation({ title: 'Contract questions' })])

    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'zzz')
    expect(await screen.findByText("I didn't find a match. Try rephrasing.")).toBeInTheDocument()
    // The grouped list is hidden while searching.
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('Escape clears the query and restores the grouped list', async () => {
    const user = userEvent.setup()
    stubApi({ searchConversations: vi.fn(async () => [result()]) })
    renderList([makeConversation({ title: 'Contract questions' })])

    const box = screen.getByRole('searchbox', { name: 'Search conversations' })
    await user.type(box, 'liability')
    await screen.findByRole('button', { name: /Contract questions/ })
    await user.keyboard('{Escape}')
    expect(box).toHaveValue('')
    expect(await screen.findByRole('group', { name: 'Earlier' })).toBeInTheDocument()
  })
})
