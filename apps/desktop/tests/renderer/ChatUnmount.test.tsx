// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ChatScreen, STREAM_FLUSH_MS } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type { Conversation, ImportJob, ImportJobStatus, Message, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// FE-1 (audit full-audit-2026-06-29): ChatScreen, like DocumentsScreen/DiagnosticsTab under
// FE-4, must not setState after unmount. Two async paths resolve AFTER the user can navigate
// away: the attach-import poll's in-flight `getImportJob` tick, and the streamed-token flush
// timer. The main-side stream is intentionally NOT torn down (it is recovered on remount via
// getActiveStream) — the fix is only a `mountedRef` gate on those setStates plus clearing the
// pending flush timer on unmount. This test unmounts with BOTH in flight and asserts the
// guards hold.

const runningStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function docConv(): Conversation {
  return {
    id: 'c1',
    title: 'Doc Q&A',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'documents',
    scopeDocumentIds: null,
    collectionId: null,
    // An explicit (docs-only) scope so attaching here does NOT raise the D71 narrow/widen dialog —
    // this test exercises the unmount guards, not the scope prompt (which a whole-library default,
    // scope:null, would trigger and whose modal would aria-hide the composer under test).
    scope: { collectionIds: [], documentIds: [] }
  }
}

// FE-A (full-audit-2026-06-29 follow-up, Phase 2): Electron 37 removed `File.path`; the dropped
// path is resolved through the preload bridge (`window.api.getDroppedFilePath`). The File carries
// no `.path` — its path is registered for the resolver, the way webUtils maps File→path in main.
const droppedPaths = new WeakMap<object, string>()
const getDroppedFilePath = vi.fn((file: object): string => droppedPaths.get(file) ?? '')

/** Fire a native-style file drop on the chat surface (no `.path` — resolved via the bridge). */
function dropFile(name: string, path: string): void {
  const target = document.querySelector('.chat-main')
  if (!target) throw new Error('no .chat-main drop target')
  const file = { name }
  droppedPaths.set(file, path)
  fireEvent.drop(target, { dataTransfer: { files: [file], types: ['Files'] } })
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
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('ChatScreen — FE-1 setState-after-unmount guards (import poll + stream flush)', () => {
  it('drops a late attach-poll tick and clears the pending stream-flush timer on unmount', async () => {
    vi.useFakeTimers()
    try {
      // Attach-import poll: getImportJob PARKS on its first tick, handing back a promise we
      // resolve by hand AFTER unmount — so the tick straddles teardown (exercises the post-await
      // guard). It resolves `done` with a per-file success, which without the guard would refresh
      // the document list (listDocuments) on a dead component.
      let releaseJob: (() => void) | null = null
      const getImportJob = vi.fn(
        (): Promise<ImportJobStatus> =>
          new Promise<ImportJobStatus>((res) => {
            releaseJob = () => res({ jobId: 'j1', total: 1, completed: 1, failed: 0, done: true })
          })
      )
      const listDocuments = vi.fn(async () => [] as never[])
      const job: ImportJob = { jobId: 'j1', documentIds: ['d1'] }

      // Stream: askDocuments PARKS (never resolves) so the stream stays in flight and onToken
      // stays subscribed — late tokens can still arrive. Capture the token callback.
      let tokenCb: ((t: string) => void) | undefined
      const askDocuments = vi.fn(() => new Promise<Message>(() => {}))

      stubApi({
        getDroppedFilePath: getDroppedFilePath as never,
        listConversations: vi.fn(async () => [docConv()]),
        getRuntimeStatus: vi.fn(async () => runningStatus),
        listMessages: vi.fn(async () => []),
        listDocuments,
        listAttachments: vi.fn(async () => []),
        getActiveStream: vi.fn(async () => null),
        importDocuments: vi.fn(async () => job),
        getImportJob,
        askDocuments,
        onToken: vi.fn((_id: string, cb: (t: string) => void) => {
          tokenCb = cb
          return () => {}
        }),
        onReasoning: vi.fn(() => () => {}),
        onScopeNotice: vi.fn(() => () => {})
      })

      const flush = async (): Promise<void> => {
        await act(async () => {
          for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
        })
      }

      const { unmount } = render(
        <ToastProvider>
          <ChatScreen onNavigate={() => {}} />
        </ToastProvider>
      )
      await flush() // mount: runtime check + conversation list

      // Select the documents conversation (activeId = c1) so the composer + in-place attach are live.
      fireEvent.click(screen.getByText('Doc Q&A'))
      await flush()

      // Drop a file → attaches to THIS documents conversation in place → watchAttachJob arms the poll.
      dropFile('invoice.pdf', '/tmp/invoice.pdf')
      await flush()

      // First poll tick (400 ms) → getImportJob parks in flight.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(releaseJob).not.toBeNull()

      // Send a message → stream starts → onToken subscribed (askDocuments parks; the stream lives on).
      fireEvent.change(screen.getByPlaceholderText(/ask about your documents/i), {
        target: { value: 'hi' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
      await flush()
      expect(askDocuments).toHaveBeenCalled()
      expect(tokenCb).toBeDefined()

      // Deliver a token → buffers + arms the STREAM_FLUSH_MS flush timer. Do NOT advance: leave it
      // pending so unmount is the only thing that can clear it.
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      act(() => tokenCb!('hello'))
      const flushArm = setTimeoutSpy.mock.calls.findIndex((c) => c[1] === STREAM_FLUSH_MS)
      expect(flushArm).toBeGreaterThanOrEqual(0)
      const flushTimerId = setTimeoutSpy.mock.results[flushArm].value

      const listDocsBefore = listDocuments.mock.calls.length

      // Unmount mid-import AND mid-stream.
      unmount()

      // (c) the pending flush timer is cleared on unmount — no stray flush survives teardown.
      // Teeth: drop the clearTimeout(flushTimer) from the unmount effect → this id is never cleared.
      expect(clearTimeoutSpy).toHaveBeenCalledWith(flushTimerId)

      // (b) the parked poll tick now resolves with done=true — after unmount. The post-await
      // mountedRef guard drops it, so no document-list refresh lands on a dead component.
      // Teeth: drop that guard → the done tick proceeds to listDocuments() → the count rises.
      await act(async () => {
        releaseJob!()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(listDocuments.mock.calls.length).toBe(listDocsBefore)
    } finally {
      vi.useRealTimers()
    }
  })
})
