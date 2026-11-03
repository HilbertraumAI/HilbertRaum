// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  DEFAULT_SETTINGS,
  type Conversation,
  type DocumentScope,
  type ImportJob,
  type ImportJobStatus,
  type SkillInfo
} from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { chatDropBridge, chatScreenStubs, renderChatScreen } from '../helpers/chat-screen'
import { hangBudgetMs } from '../helpers/hang-budget'
import { makeSkillInfo, makeCollection, makeConversation, makeDocumentInfo } from '../helpers/chat-fixtures'

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

function skill(): SkillInfo {
  return makeSkillInfo({
    description: 'Explains a bank statement in plain language.',
    permissionSummary: 'can read the documents you pick for a turn.'
  })
}

// The run-bar offer button for a read-only tool (SkillRunBar labels it from the tool name).
const RUN_BUTTON = { name: 'Extract transactions' }
const RUNNABLE = { name: 'extract_transactions', requiresConfirmation: false }

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
  }
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
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [{ ...docConv, scope: persistedScope }]),
        listDocuments: vi.fn(async () => [makeDocumentInfo({ id: 'd1', title: 'contract.pdf' })]),
        listCollections: vi.fn(async () => [
          makeCollection(),
          makeCollection({ id: 'proj1', name: 'Tax 2025', type: 'project', builtin: false })
        ]),
        setConversationScope
      })
    )
    renderChatScreen()
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
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [docConv]),
        listDocuments: vi.fn(async () => [makeDocumentInfo({ id: 'd1', title: 'contract.pdf' })]),
        listCollections: vi.fn(async () => [makeCollection()]),
        listSkills: vi.fn(async () => [skill()]),
        // The skill's #46 info card was already seen, so the first pick opens no card (and writes no
        // settings): this row is about the run-bar offer, not the card.
        getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, skillInfoSeen: ['bank-statement'] })),
        // A pick in a saved conversation clears its saved default skill (U3).
        setConversationDefaultSkill: vi.fn(async () => {}),
        listRunnableTools,
        setConversationScope: vi.fn(async () => {
          scopeWritten = true
          return docConv
        })
      })
    )
    renderChatScreen()
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
    const drops = chatDropBridge()
    stubApi(
      chatScreenStubs({
        ...drops.stubs,
        listConversations: vi.fn(async () => [docConv]),
        listDocuments: vi.fn(async () => [makeDocumentInfo({ id: 'd0', title: 'lease.pdf' })]),
        listCollections: vi.fn(async () => [makeCollection()]),
        listSkills: vi.fn(async () => [skill()]),
        // As in the row above: the info card was already seen, and the pick clears the saved default.
        getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, skillInfoSeen: ['bank-statement'] })),
        setConversationDefaultSkill: vi.fn(async () => {}),
        listRunnableTools,
        importDocuments: vi.fn(async () => job),
        getImportJob: vi.fn(async () => {
          jobSettled = true
          return jobDone
        })
      })
    )
    renderChatScreen()
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
    drops.drop(target, 'statement.pdf', '/tmp/statement.pdf')

    expect(await screen.findByRole('button', RUN_BUTTON, { timeout: hangBudgetMs(3000) })).toBeInTheDocument()
  })
})
