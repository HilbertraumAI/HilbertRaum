// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConversationList, splitSnippet } from '../../src/renderer/chat/ConversationList'
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type Conversation,
  type ConversationSearchResult
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 31 renderer tests: the search box atop the conversation list — typing swaps
// the column to full-text results (matched terms highlighted via the SEARCH_MARK
// markers, never HTML), picking a result opens its conversation, and the friendly
// no-matches copy (spec §11.4).

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Contract questions',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    ...over
  }
}

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
  cleanup()
  vi.restoreAllMocks()
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

describe('ConversationList — search (Phase 31)', () => {
  it('typing searches and shows highlighted results; picking one opens the conversation', async () => {
    const user = userEvent.setup()
    const c = conv()
    const onSelect = vi.fn()
    const searchConversations = vi.fn(async () => [result()])
    stubApi({ searchConversations })
    renderList([c], onSelect)

    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'liability')
    const row = await screen.findByRole('button', { name: /Contract questions/ })
    // Debounced: one IPC call for the finished query, not one per keystroke.
    await waitFor(() => expect(searchConversations).toHaveBeenCalledWith('liability'))
    // The matched term renders as <mark>, the rest as plain text.
    expect(screen.getByText('liability').tagName).toBe('MARK')
    expect(row.textContent).toContain('the liability cap is two million')

    await user.click(row)
    expect(onSelect).toHaveBeenCalledWith(c)
    // Picking a result clears the search and returns to the normal grouped list.
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('')
  })

  it('shows friendly copy when nothing matches', async () => {
    const user = userEvent.setup()
    stubApi({ searchConversations: vi.fn(async () => []) })
    renderList([conv()])

    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'zzz')
    expect(await screen.findByText('No matches yet — try a different word.')).toBeInTheDocument()
    // The grouped list is hidden while searching.
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('Escape clears the query and restores the grouped list', async () => {
    const user = userEvent.setup()
    stubApi({ searchConversations: vi.fn(async () => [result()]) })
    renderList([conv()])

    const box = screen.getByRole('searchbox', { name: 'Search conversations' })
    await user.type(box, 'liability')
    await screen.findByRole('button', { name: /Contract questions/ })
    await user.keyboard('{Escape}')
    expect(box).toHaveValue('')
    expect(await screen.findByRole('group', { name: 'Earlier' })).toBeInTheDocument()
  })
})
