// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type {
  Collection,
  Conversation,
  DocumentInfo,
  KnowledgePack,
  KnowledgePacksChangedEvent,
  RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// #301 P3b, finding L7 (plan §9.17 (e)3) — the Chat half of T13, modelled on
// ChatScopeToolsRefresh.test.tsx's CH-2 pattern.
//
// `packs` is loaded once on ChatScreen mount and `packs:list` is DB-only, so a file dropped
// into the drive's `zim/` folder or a Refresh clicked in the Documents panel would otherwise
// never reach an already-mounted Chat's ScopePopover without a navigation round trip. The fix
// subscribes to `onKnowledgePacksChanged` and refetches on every event, ignoring one whose
// epoch is below the last seen (an old session's late announcement).

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Doc Q&A',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'documents',
    scopeDocumentIds: null,
    collectionId: null,
    scope: { collectionIds: [], documentIds: [] },
    ...over
  }
}

const runningStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function docInfo(id: string, title: string): DocumentInfo {
  return {
    id,
    title,
    originalPath: null,
    mimeType: 'application/pdf',
    sizeBytes: 10,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  } as DocumentInfo
}

function collection(over: Partial<Collection>): Collection {
  return {
    id: 'lib',
    name: 'Library',
    type: 'library',
    description: null,
    builtin: true,
    color: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    ...over
  } as Collection
}

function pack(over: Partial<KnowledgePack> = {}): KnowledgePack {
  return {
    id: 'uuid-climate',
    title: 'Klimawandel von Wikipedia',
    description: null,
    language: 'deu',
    zimDate: '2026-07-01',
    articleCount: 4102,
    sizeBytes: 27 * 1024 * 1024,
    leaf: 'wikipedia_de_climate.zim',
    enabled: true,
    available: true,
    unavailableReason: null,
    addedAt: '2026-09-01T00:00:00Z',
    ...over
  }
}

/** A controllable `onKnowledgePacksChanged` stand-in: the test holds `emit` and calls it
 *  whenever the "main process" would broadcast the event. */
function packsEventEmitter(): {
  onKnowledgePacksChanged: (cb: (event: KnowledgePacksChangedEvent) => void) => () => void
  emit: (event: KnowledgePacksChangedEvent) => void
} {
  let cb: ((event: KnowledgePacksChangedEvent) => void) | null = null
  return {
    onKnowledgePacksChanged: (fn) => {
      cb = fn
      return () => {
        cb = null
      }
    },
    emit: (event) => cb?.(event)
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
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('ChatScreen — mounted-consumer refresh on packs:changed (#301 P3b, T13)', () => {
  it('a reconcile-end event refetches packs and the mounted ScopePopover shows the new pack', async () => {
    const user = userEvent.setup()
    const docConv = conv()
    const emitter = packsEventEmitter()
    let listCalls = 0
    const listKnowledgePacks = vi.fn(async () => {
      listCalls++
      return listCalls === 1 ? [] : [pack()]
    })
    stubApi({
      listConversations: vi.fn(async () => [docConv]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d1', 'contract.pdf')]),
      listCollections: vi.fn(async () => [collection({})]),
      listAttachments: vi.fn(async () => []),
      listKnowledgePacks,
      onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Doc Q&A'))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(1))

    // The empty pack list at mount: no navigation happens, the popover just has no packs yet.
    await user.click(await screen.findByRole('button', { name: /answering from/i }))
    expect(
      screen.queryByRole('checkbox', { name: /Klimawandel von Wikipedia/ })
    ).not.toBeInTheDocument()

    // The main process finishes a reconciliation — the mounted popover sees the new pack
    // WITHOUT the chat being navigated away and back.
    act(() => emitter.emit({ epoch: 1, revision: 1, refreshing: false, reason: 'reconcile-end' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
    expect(
      await screen.findByRole('checkbox', { name: /Klimawandel von Wikipedia/ })
    ).toBeInTheDocument()
  })

  it('an older-epoch event is ignored: no refetch', async () => {
    const user = userEvent.setup()
    const docConv = conv()
    const emitter = packsEventEmitter()
    const listKnowledgePacks = vi.fn(async () => [] as KnowledgePack[])
    stubApi({
      listConversations: vi.fn(async () => [docConv]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d1', 'contract.pdf')]),
      listCollections: vi.fn(async () => [collection({})]),
      listAttachments: vi.fn(async () => []),
      listKnowledgePacks,
      onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Doc Q&A'))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(1))

    // A newer epoch first advances what counts as "last seen"…
    act(() => emitter.emit({ epoch: 5, revision: 2, refreshing: false, reason: 'mutation' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
    // …then an OLDER epoch (an old session's late announcement) must change nothing.
    act(() => emitter.emit({ epoch: 3, revision: 3, refreshing: false, reason: 'reconcile-end' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(listKnowledgePacks).toHaveBeenCalledTimes(2)
  })
})
