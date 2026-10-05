// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { ToastProvider } from '../../src/renderer/components'
import type {
  Collection,
  Conversation,
  DocumentInfo,
  DocumentScope,
  ImportJob,
  ImportJobStatus,
  RuntimeStatus,
  SkillInfo
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { hangBudgetMs } from '../helpers/hang-budget'
import { makeSkillInfo, makeConversation } from '../helpers/chat-fixtures'

// CH-1 + CH-2 (frontend audit 2026-08-09, issues #139/#140).
//
// CH-1: every scope-popover toggle computes the NEXT scope from the scope it renders. Before
// the fix that was the conversations-derived prop, refreshed only after setConversationScope +
// refreshConversations resolved — so a second toggle inside that window computed from the
// pre-first-click scope and silently reverted the first change (a lost update persisted into
// scope_v2_json). The fix renders an optimistic scope immediately and serializes the writes.
//
// CH-2: the listRunnableTools effect was keyed only on (skill, conversation), so the run-bar
// offer went stale when the in-scope document set changed mid-conversation — a scope write or
// an attach-job settle (the #44 "invisible run button" class). The fix re-fires it on both.

function conv(over: Partial<Conversation> = {}): Conversation {
  return makeConversation({ title: 'Doc Q&A', mode: 'documents', scope: { collectionIds: [], documentIds: [] }, ...over })
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

function skill(): SkillInfo {
  return makeSkillInfo({
    description: 'Explains a bank statement in plain language.',
    permissionSummary: 'can read the documents you pick for a turn.'
  })
}

const unsub = (): (() => void) => () => {}

// The run-bar offer button for a read-only tool (SkillRunBar labels it from the tool name).
const RUN_BUTTON = { name: 'Extract transactions' }
const RUNNABLE = { name: 'extract_transactions', requiresConfirmation: false }

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

describe('ChatScreen — scope-popover rapid toggles do not race (CH-1, #139)', () => {
  it('a second toggle before the first persist lands compounds onto it instead of reverting it', async () => {
    const user = userEvent.setup()
    const docConv = conv()
    // A manually-released persist that behaves like main: both toggles happen while the FIRST
    // write is in flight, and each release commits its write's scope as the persisted truth.
    let persistedScope: DocumentScope | null = docConv.scope
    const resolvers: Array<() => void> = []
    const setConversationScope = vi.fn(
      (_conversationId: string, scope: DocumentScope | null) =>
        new Promise<Conversation>((resolve) => {
          resolvers.push(() => {
            persistedScope = scope
            resolve({ ...docConv, scope: persistedScope })
          })
        })
    )
    stubApi({
      listConversations: vi.fn(async () => [{ ...docConv, scope: persistedScope }]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d1', 'contract.pdf')]),
      listCollections: vi.fn(async () => [
        collection({}),
        collection({ id: 'proj1', name: 'Tax 2025', type: 'project', builtin: false })
      ]),
      listAttachments: vi.fn(async () => []),
      setConversationScope
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Doc Q&A'))

    // Open the picker and tick Library, then the project, BEFORE the first write resolves.
    await user.click(await screen.findByRole('button', { name: /answering from/i }))
    await user.click(await screen.findByRole('checkbox', { name: /library/i }))
    await user.click(await screen.findByRole('checkbox', { name: /tax 2025/i }))

    // The second write is serialized behind the first — only one IPC call so far, with the
    // first toggle's scope.
    expect(setConversationScope).toHaveBeenCalledTimes(1)
    expect(setConversationScope).toHaveBeenNthCalledWith(1, 'c1', {
      collectionIds: ['lib'],
      documentIds: []
    })

    // Release the first write: the queued second write must carry BOTH sources. Pre-fix the
    // second toggle computed from the stale props scope and emitted ['proj1'] alone —
    // silently dropping Library (the lost update this test pins).
    resolvers[0]()
    await waitFor(() => expect(setConversationScope).toHaveBeenCalledTimes(2))
    expect(setConversationScope).toHaveBeenNthCalledWith(2, 'c1', {
      collectionIds: ['lib', 'proj1'],
      documentIds: []
    })
    resolvers[1]()
    // Both checkboxes stay ticked (the optimistic scope is what the popover renders).
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /tax 2025/i })).toBeChecked()
    )
    expect(screen.getByRole('checkbox', { name: /library/i })).toBeChecked()
  })
})

describe('ChatScreen — runnable-tool offer re-resolves on scope change (CH-2, #140)', () => {
  it('the run button appears after a successful scope write (the offer re-resolves)', async () => {
    const user = userEvent.setup()
    const docConv = conv()
    // State-keyed stub: main only reports the tool once the scope write has landed, so the button's
    // appearance proves the offer re-resolved AFTER the write — not that a call count was reached.
    let scopeWritten = false
    const listRunnableTools = vi.fn(async () =>
      scopeWritten ? { tools: [RUNNABLE], documentIds: ['d1'] } : { tools: [], documentIds: [] }
    )
    stubApi({
      listConversations: vi.fn(async () => [docConv]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d1', 'contract.pdf')]),
      listCollections: vi.fn(async () => [collection({})]),
      listAttachments: vi.fn(async () => []),
      listSkills: vi.fn(async () => [skill()]),
      suggestSkills: vi.fn(async () => []),
      listSkillRuns: vi.fn(async () => []),
      listRunnableTools,
      setConversationScope: vi.fn(async () => {
        scopeWritten = true
        return docConv
      })
    })
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByText('Doc Q&A'))
    // Pick the skill — the effect resolves the offer once for (skill, conversation).
    await user.click(await screen.findByRole('button', { name: /^skill:/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    await waitFor(() => expect(listRunnableTools).toHaveBeenCalled())
    expect(screen.queryByRole('button', RUN_BUTTON)).not.toBeInTheDocument()

    // Edit the scope: after the write resolves, the offer must re-resolve — before the fix the
    // effect (keyed only on skill + conversation ids) never re-fired and the run bar stayed stale.
    await user.click(screen.getByRole('button', { name: /answering from/i }))
    await user.click(await screen.findByRole('checkbox', { name: /library/i }))
    expect(await screen.findByRole('button', RUN_BUTTON, { timeout: hangBudgetMs(3000) })).toBeInTheDocument()
  })

  it('the run button appears when an attach-job settles (the #44 invisible-run-button class)', async () => {
    const user = userEvent.setup()
    const docConv = conv({ scope: { collectionIds: [], documentIds: ['d0'] } })
    // State-keyed: the tool is only reported once the import job has settled (main resolves in-scope
    // docs at fetch time), so a fetch at pick time yields no button.
    let jobSettled = false
    const listRunnableTools = vi.fn(async () =>
      jobSettled ? { tools: [RUNNABLE], documentIds: ['d0'] } : { tools: [], documentIds: [] }
    )
    const job: ImportJob = { jobId: 'j1', documentIds: ['d9'] }
    const jobDone: ImportJobStatus = { jobId: 'j1', total: 1, completed: 1, failed: 0, done: true }
    const droppedPaths = new WeakMap<object, string>()
    stubApi({
      listConversations: vi.fn(async () => [docConv]),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [docInfo('d0', 'lease.pdf')]),
      listCollections: vi.fn(async () => [collection({})]),
      listAttachments: vi.fn(async () => []),
      listSkills: vi.fn(async () => [skill()]),
      suggestSkills: vi.fn(async () => []),
      listSkillRuns: vi.fn(async () => []),
      listRunnableTools,
      importDocuments: vi.fn(async () => job),
      getImportJob: vi.fn(async () => {
        jobSettled = true
        return jobDone
      }),
      getDroppedFilePath: vi.fn((file: File): string => droppedPaths.get(file) ?? '')
    })
    render(
      <ToastProvider>
        <ChatScreen onNavigate={() => {}} />
      </ToastProvider>
    )
    await user.click(await screen.findByText('Doc Q&A'))
    await user.click(await screen.findByRole('button', { name: /^skill:/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    await waitFor(() => expect(listRunnableTools).toHaveBeenCalled())
    expect(screen.queryByRole('button', RUN_BUTTON)).not.toBeInTheDocument()

    // Drop a statement into the chat; when the import job settles, the offer must re-resolve —
    // main resolves in-scope docs at fetch time, and before the fix the only fetch happened at
    // pick time (before the link row existed), so the run button never appeared.
    const target = document.querySelector('.chat-main')
    if (!target) throw new Error('no .chat-main drop target')
    const file = { name: 'statement.pdf' }
    droppedPaths.set(file, '/tmp/statement.pdf')
    fireEvent.drop(target, { dataTransfer: { files: [file], types: ['Files'] } })

    expect(await screen.findByRole('button', RUN_BUTTON, { timeout: hangBudgetMs(3000) })).toBeInTheDocument()
  })
})
