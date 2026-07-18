// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { AppSettings, AppStatus, Conversation, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// EP-1 P5 (plan §10) — "Back to chat" returns to the ORIGINATING conversation: App hands
// the review's conversationId to ChatScreen as `initialConversationId`, and the mount-time
// re-attach effect selects it (verified against the loaded list; the same `activeIdRef`
// one-shot idiom as the stream/skill-run re-attach effects). A deleted/unknown id degrades
// to the plain chat-home landing — never a phantom selection.

const idleStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId: null,
    scope: null,
    ...over
  }
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function baseStubs(conversations: Conversation[]) {
  return {
    listConversations: vi.fn(async () => conversations),
    getRuntimeStatus: vi.fn(async () => idleStatus),
    listMessages: vi.fn(async () => []),
    listDocuments: vi.fn(async () => []),
    listCollections: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getAppStatus: vi.fn(async () => ({ dictationAvailable: false }) as AppStatus),
    getActiveStream: vi.fn(async () => null),
    listActiveStreamConversations: vi.fn(async () => []),
    getConversationContextUsage: vi.fn(async () => null),
    getConversationSummary: vi.fn(async () => null),
    listSkillRuns: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({}) as AppSettings)
  }
}

/** The conversation-row button (`.chat-conv`) for a title, or null. The title also appears
 *  in the row's "⋯" aria-label, so role+name lookups are ambiguous — query the row class. */
function convRow(title: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('.chat-conv')).find((el) =>
      (el.textContent ?? '').includes(title)
    ) ?? null
  )
}

describe('ChatScreen — back-to-originating-conversation handoff (P5)', () => {
  it('selects the handed-off conversation on mount (history loads, row current, mode mirrors)', async () => {
    const stubs = baseStubs([conv('c1'), conv('c2', { mode: 'documents' })])
    stubApi(stubs)
    render(
      <ChatScreen onNavigate={() => {}} initialConversationId="c2" onOpenReview={() => {}} />
    )

    // The re-attach effect resolved: c2 is the ACTIVE conversation.
    await waitFor(() => expect(stubs.listMessages).toHaveBeenCalledWith('c2'))
    await waitFor(() =>
      expect(convRow('Conversation c2')).toHaveAttribute('aria-current', 'true')
    )
    // Never a spurious load of some other conversation.
    expect(stubs.listMessages).not.toHaveBeenCalledWith('c1')
  })

  it('an unknown (deleted) id degrades to chat home — nothing selected, nothing loaded', async () => {
    const stubs = baseStubs([conv('c1')])
    stubApi(stubs)
    render(
      <ChatScreen onNavigate={() => {}} initialConversationId="gone" onOpenReview={() => {}} />
    )

    // Let the mount + re-attach effects settle, then: no history load, no current row.
    await waitFor(() => expect(convRow('Conversation c1')).not.toBeNull())
    expect(stubs.listMessages).not.toHaveBeenCalled()
    expect(convRow('Conversation c1')).not.toHaveAttribute('aria-current')
  })

  it('without a handoff the mount stays on chat home (baseline unchanged)', async () => {
    const stubs = baseStubs([conv('c1')])
    stubApi(stubs)
    render(<ChatScreen onNavigate={() => {}} onOpenReview={() => {}} />)

    await waitFor(() => expect(convRow('Conversation c1')).not.toBeNull())
    expect(stubs.listMessages).not.toHaveBeenCalled()
  })
})
