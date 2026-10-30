// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, act } from '@testing-library/react'
import type { Conversation, DocumentInfo, ImportJob, ImportJobStatus } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import {
  chatDropBridge,
  chatScreenStubs,
  conversationRow,
  deferred,
  flushFakeTimers,
  renderChatScreen
} from '../helpers/chat-screen'
import { makeConversation } from '../helpers/chat-fixtures'

// FE-1 (audit full-audit-2026-06-29): ChatScreen, like DocumentsScreen/DiagnosticsTab under
// FE-4, must not setState after unmount. Two async paths resolve AFTER the user can navigate
// away: the attach-import poll's in-flight `getImportJob` tick, and the streamed-token flush
// timer. The main-side stream is intentionally NOT torn down (it is recovered on remount via
// getActiveStream) — the fix is a `mountedRef` gate on those paths plus clearing the pending
// flush timer on unmount. Only the attach-poll guard has an observable: a late tick that got
// through would refresh the document list (listDocuments) on a dead screen. The flush-timer
// guard is defensive only — React 18 makes a post-unmount setState a silent no-op, so no test
// can see it (the chat-ui test campaign removed a warning check that could not fail).

// Differs from makeConversation: documents mode + an explicit docs-only scope, so attaching here does NOT
// raise the D71 narrow/widen dialog (a whole-library default, scope: null, would, and its modal would
// aria-hide the composer).
const docConv = (): Conversation =>
  makeConversation({ title: 'Doc Q&A', mode: 'documents', scope: { collectionIds: [], documentIds: [] } })

afterEach(() => {
  assertNoUnexpectedApiCalls()
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('ChatScreen — FE-1 setState-after-unmount guards (import poll)', () => {
  it('drops a late attach-poll tick that resolves after unmount — no document refresh on a dead screen', async () => {
    vi.useFakeTimers()
    try {
      // Attach-import poll: getImportJob PARKS on its first tick and is resolved by hand AFTER unmount,
      // so the tick straddles teardown (the post-await guard). It resolves `done` with a per-file success,
      // which without the guard would refresh the document list on a dead component.
      const job = deferred<ImportJobStatus>()
      const getImportJob = vi.fn(() => job.promise)
      const listDocuments = vi.fn(async (): Promise<DocumentInfo[]> => [])
      // FE-A: Electron 37 removed `File.path`; the dropped path is resolved through the preload bridge.
      const drops = chatDropBridge()
      stubApi(
        chatScreenStubs({
          ...drops.stubs,
          listConversations: vi.fn(async () => [docConv()]),
          listDocuments,
          importDocuments: vi.fn(async (): Promise<ImportJob> => ({ jobId: 'j1', documentIds: ['d1'] })),
          getImportJob
        })
      )

      const { unmount } = renderChatScreen()
      await flushFakeTimers() // mount: runtime check + conversation list

      // Select the documents conversation (activeId = c1) so the in-place attach is live.
      fireEvent.click(conversationRow('Doc Q&A'))
      await flushFakeTimers()

      // Drop a file → attaches to THIS documents conversation in place → watchAttachJob arms the poll.
      drops.drop(document.querySelector('.chat-main')!, 'invoice.pdf', '/tmp/invoice.pdf')
      await flushFakeTimers()

      // First poll tick — watchAttachJob's interval is a bare 400 in ChatScreen.tsx (no exported constant).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(getImportJob).toHaveBeenCalledTimes(1) // the tick is parked in flight
      const listDocsBefore = listDocuments.mock.calls.length

      unmount()
      await act(async () => job.resolve({ jobId: 'j1', total: 1, completed: 1, failed: 0, done: true }))
      await flushFakeTimers()

      // The post-await mountedRef guard drops the late tick: no document-list refresh on a dead screen.
      // Teeth: drop that guard → the done tick proceeds to listDocuments() → the count rises.
      expect(listDocuments.mock.calls.length).toBe(listDocsBefore)
    } finally {
      vi.useRealTimers()
    }
  })
})
