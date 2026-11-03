// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Conversation } from '../../src/shared/types'
import { knowledgePack, packsEventEmitter } from '../helpers/knowledge-pack-fixtures'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { chatScreenStubs, renderChatScreen } from '../helpers/chat-screen'
import { makeCollection, makeConversation, makeDocumentInfo } from '../helpers/chat-fixtures'

// #301 P3b, finding L7 (plan §9.17 (e)3) — the Chat half of T13, modelled on
// ChatScopeToolsRefresh.test.tsx's CH-2 pattern.
//
// `packs` is loaded once on ChatScreen mount and `packs:list` is DB-only, so a file dropped
// into the drive's `zim/` folder or a Refresh clicked in the Documents panel would otherwise
// never reach an already-mounted Chat's ScopePopover without a navigation round trip. The fix
// subscribes to `onKnowledgePacksChanged` and refetches on every event, ignoring one whose
// epoch is below the last seen (an old session's late announcement).

// Differs from makeConversation: documents mode + an explicit docs-only scope (no D71 dialog).
function conv(over: Partial<Conversation> = {}): Conversation {
  return makeConversation({ title: 'Doc Q&A', mode: 'documents', scope: { collectionIds: [], documentIds: [] }, ...over })
}

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
  }
})

describe('ChatScreen — mounted-consumer refresh on packs:changed (#301 P3b, T13)', () => {
  // #340 nit: `reconcile-start` says a pass BEGAN — the pack set cannot have moved yet — so the
  // chat refetches at `reconcile-end` / `mutation` only, one DB read per pass instead of two.
  it('a reconcile-start event does not refetch; the following reconcile-end does', async () => {
    const user = userEvent.setup()
    const docConv = conv()
    const emitter = packsEventEmitter()
    const listKnowledgePacks = vi.fn(async () => [knowledgePack()])
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [docConv]),
        listDocuments: vi.fn(async () => [makeDocumentInfo({ id: 'd1', title: 'contract.pdf' })]),
        listCollections: vi.fn(async () => [makeCollection()]),
        listKnowledgePacks,
        onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
      })
    )
    renderChatScreen()
    await user.click(await screen.findByText('Doc Q&A'))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(1))

    // A start notice under a NEWER epoch than anything seen: honoured as an epoch, not a refetch.
    await act(async () => {
      emitter.emit({ epoch: 2, revision: 2, refreshing: true, reason: 'reconcile-start' })
    })
    expect(listKnowledgePacks).toHaveBeenCalledTimes(1) // a flushed ceiling, not a proof of absence
    act(() => emitter.emit({ epoch: 2, revision: 2, refreshing: false, reason: 'reconcile-end' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
    // …and the epoch the start notice carried was recorded: an OLDER end notice is ignored.
    act(() => emitter.emit({ epoch: 1, revision: 1, refreshing: false, reason: 'reconcile-end' }))
    await act(async () => {})
    expect(listKnowledgePacks).toHaveBeenCalledTimes(2)
  })

  it('a reconcile-end event refetches packs and the mounted ScopePopover shows the new pack; an older-epoch event refetches nothing', async () => {
    const user = userEvent.setup()
    const docConv = conv()
    const emitter = packsEventEmitter()
    let listCalls = 0
    const listKnowledgePacks = vi.fn(async () => {
      listCalls++
      return listCalls === 1 ? [] : [knowledgePack()]
    })
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [docConv]),
        listDocuments: vi.fn(async () => [makeDocumentInfo({ id: 'd1', title: 'contract.pdf' })]),
        listCollections: vi.fn(async () => [makeCollection()]),
        listKnowledgePacks,
        onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
      })
    )
    renderChatScreen()
    await user.click(await screen.findByText('Doc Q&A'))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(1))

    // The empty pack list at mount: no navigation happens, the popover just has no packs yet.
    await user.click(await screen.findByRole('button', { name: /answering from/i }))
    expect(
      screen.queryByRole('checkbox', { name: /Klimawandel von Wikipedia/ })
    ).not.toBeInTheDocument()

    // The main process finishes a reconciliation — the mounted popover sees the new pack
    // WITHOUT the chat being navigated away and back.
    act(() => emitter.emit({ epoch: 2, revision: 1, refreshing: false, reason: 'reconcile-end' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
    expect(
      await screen.findByRole('checkbox', { name: /Klimawandel von Wikipedia/ })
    ).toBeInTheDocument()
    // An OLDER epoch (an old session's late announcement) changes nothing, whatever its revision.
    // Exact without a wait: the listener calls `listKnowledgePacks` synchronously.
    act(() => emitter.emit({ epoch: 1, revision: 9, refreshing: false, reason: 'reconcile-end' }))
    expect(listKnowledgePacks).toHaveBeenCalledTimes(2)
  })

  it('a failed REFETCH keeps the pack list the chat already knows (#301 P6)', async () => {
    // One transient IPC failure on a packs:changed event must not wipe known-good state:
    // before P6 the catch reset the list to [], which also removed the Documents toggle and
    // could collapse a documents-empty chat into the "Add documents" jump.
    const user = userEvent.setup()
    const docConv = conv()
    const emitter = packsEventEmitter()
    let listCalls = 0
    const listKnowledgePacks = vi.fn(async () => {
      listCalls++
      if (listCalls === 2) throw new Error('transient IPC failure')
      return [knowledgePack()]
    })
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [docConv]),
        listDocuments: vi.fn(async () => [makeDocumentInfo({ id: 'd1', title: 'contract.pdf' })]),
        listCollections: vi.fn(async () => [makeCollection()]),
        listKnowledgePacks,
        onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
      })
    )
    renderChatScreen()
    await user.click(await screen.findByText('Doc Q&A'))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(1))
    await user.click(await screen.findByRole('button', { name: /answering from/i }))
    expect(await screen.findByRole('checkbox', { name: /Klimawandel von Wikipedia/ })).toBeInTheDocument()

    // The refetch this event triggers throws — the mounted popover must still list the pack once
    // that failure has been handled, before anything else refetches.
    act(() => emitter.emit({ epoch: 1, revision: 1, refreshing: false, reason: 'reconcile-end' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
    await act(async () => {
      await (listKnowledgePacks.mock.results[1]!.value as Promise<unknown>).catch(() => undefined)
    })
    expect(screen.getByRole('checkbox', { name: /Klimawandel von Wikipedia/ })).toBeInTheDocument()
    // A later successful refetch proves the subscription is still alive after the failure.
    act(() => emitter.emit({ epoch: 2, revision: 2, refreshing: false, reason: 'mutation' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('checkbox', { name: /Klimawandel von Wikipedia/ })).toBeInTheDocument()
  })
})
