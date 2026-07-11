// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { startSkillRun, resetSkillRunStoreForTests } from '../../src/renderer/lib/skillruns'
import type { Conversation, RuntimeStatus, SkillInfo, SkillRunState, DocumentInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// SKA-6/SKA-17 (skills audit 2026-07-03, U6) — the ChatScreen wiring of the per-run store. These
// exercise the invariants that had ZERO renderer coverage: the run bar is gated to the launching
// conversation (a run in chat A never renders in chat B), a "working in another chat" chip covers a
// run elsewhere, and the routed-run relay lands its answer in the RUN's conversation (C1), under the
// RUN's skill (C2), pinned to the RUN's document (ux-6) — resolving the pin BEFORE acknowledge.

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'convA',
    title: 'Chat A',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'documents',
    scopeDocumentIds: ['docA'],
    collectionId: null,
    scope: { collectionIds: [], documentIds: ['docA'] },
    ...over
  }
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: true, modelId: 'm1', port: 1234, healthy: true, message: 'ok', ...over }
}

function doc(id: string, title: string): DocumentInfo {
  return { id, title, status: 'indexed', mimeType: 'text/plain', createdAt: 't', updatedAt: 't' } as unknown as DocumentInfo
}

function runState(over: Partial<SkillRunState>): SkillRunState {
  return {
    runHandle: 'h',
    skillInstallId: 'app:bank-statement',
    toolName: 'extract_transactions',
    documentCount: 1,
    state: 'done',
    progress: { done: 0, total: 0 },
    ...over
  }
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} })
})

afterEach(() => {
  resetSkillRunStoreForTests()
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const unsub = () => () => {}

/** Stub the bridge for a two-conversation, documents-mode ChatScreen; return the spies a test asserts. */
function baseApi(runs: Record<string, SkillRunState>, extra: Record<string, unknown> = {}): { askDocuments: ReturnType<typeof vi.fn> } {
  const askDocuments = vi.fn(async () => {})
  stubApi({
    listConversations: vi.fn(async () => [conv(), conv({ id: 'convB', title: 'Chat B', scopeDocumentIds: ['docB'], scope: { collectionIds: [], documentIds: ['docB'] } })]),
    getRuntimeStatus: vi.fn(async () => status()),
    listMessages: vi.fn(async () => []),
    listDocuments: vi.fn(async () => [doc('docA', 'a.pdf'), doc('docB', 'b.pdf')]),
    listSkills: vi.fn(async () => [] as SkillInfo[]),
    suggestSkills: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
    getAppStatus: vi.fn(async () => ({ dictationAvailable: false })),
    // The per-run store surface.
    startSkillRun: vi.fn(async (req: { documentId?: string }) => ({ started: true, run: runs[req.documentId ?? ''] })),
    getSkillRun: vi.fn(async (h: string) => Object.values(runs).find((r) => r.runHandle === h) ?? null),
    clearSkillRun: vi.fn(async () => {}),
    listSkillRuns: vi.fn(async () => []),
    // Streaming surface the routed relay's `stream()` touches.
    onToken: vi.fn(unsub),
    onReasoning: vi.fn(unsub),
    onScopeNotice: vi.fn(unsub),
    onCompaction: vi.fn(unsub),
    askDocuments,
    ...extra
  } as unknown as Parameters<typeof stubApi>[0])
  return { askDocuments }
}

async function selectConversation(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(await screen.findByText(title))
}

describe('ChatScreen — per-run store gating (SKA-6)', () => {
  it("a run in another conversation NEVER renders its result row in the active conversation", async () => {
    const runs = { docB: runState({ runHandle: 'hB', conversationId: 'convB', documentId: 'docB', state: 'done', transactionCount: 9 }) }
    baseApi(runs)
    const user = userEvent.setup()
    render(<ChatScreen onNavigate={() => {}} />)
    await selectConversation(user, 'Chat A') // active = convA
    // Seed a finished run in convB while convA is active.
    await act(async () => {
      await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'convB', documentId: 'docB' })
    })
    // convA shows NO result row for convB's run (the foreign-conversation replay the audit describes).
    expect(screen.queryByText('Extracted 9 transactions.')).not.toBeInTheDocument()
    // Switching to convB surfaces its outcome.
    await selectConversation(user, 'Chat B')
    expect(await screen.findByText('Extracted 9 transactions.')).toBeInTheDocument()
  })

  it('shows a quiet "working in another chat" chip when a run is running elsewhere', async () => {
    const runs = { docB: runState({ runHandle: 'hB', conversationId: 'convB', documentId: 'docB', state: 'running' }) }
    baseApi(runs)
    const user = userEvent.setup()
    render(<ChatScreen onNavigate={() => {}} />)
    await selectConversation(user, 'Chat A')
    await act(async () => {
      await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'extract_transactions', conversationId: 'convB', documentId: 'docB' })
    })
    expect(await screen.findByText('A skill is working in another chat.')).toBeInTheDocument()
    // …and no busy row for convA itself (it has no run).
    expect(screen.queryByText(/Running:/)).not.toBeInTheDocument()
  })

  it('re-adopts an in-flight run on a fresh mount and lands on its conversation, showing the outcome (SKA-17)', async () => {
    const term = runState({ runHandle: 'hB', conversationId: 'convB', documentId: 'docB', state: 'done', transactionCount: 5 })
    baseApi({ docB: term }, { listSkillRuns: vi.fn(async () => [term]) })
    render(<ChatScreen onNavigate={() => {}} />)
    // No manual selection — the mount re-adopts the run and lands on convB, showing its terminal outcome.
    expect(await screen.findByText('Extracted 5 transactions.')).toBeInTheDocument()
  })
})

describe('ChatScreen — routed-run relay invariants (C1/C2/ux-6)', () => {
  it('routes the summarize answer into the RUN’s conversation, under the RUN’s skill, pinned to the RUN’s document', async () => {
    const runs = {
      docA: runState({ runHandle: 'hA', skillInstallId: 'app:bank-statement', toolName: 'summarize_cashflow', conversationId: 'convA', documentId: 'docA', state: 'done', transactionCount: 4 })
    }
    const { askDocuments } = baseApi(runs)
    const user = userEvent.setup()
    render(<ChatScreen onNavigate={() => {}} />)
    await selectConversation(user, 'Chat A') // documents mode, no skill picked in the composer
    // A routed run (summarize_cashflow) finishes for convA — seed it via the same store ChatScreen reads.
    await act(async () => {
      await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'summarize_cashflow', conversationId: 'convA', documentId: 'docA' })
    })
    // The relay streams the summarize question as a real chat answer:
    //  C1 — into convA (the launching conversation),
    //  C2 — under the RUN's skill (app:bank-statement), NOT the composer's current pick (none here),
    //  ux-6 — pinned to docA (the run's document, resolved from the store entry before acknowledge).
    await waitFor(() =>
      expect(askDocuments).toHaveBeenCalledWith('convA', 'Summarize my income and expenses.', 'app:bank-statement', false, 'docA')
    )
  })

  it('does NOT relay when the run’s conversation is not the active one (C1)', async () => {
    const runs = {
      docB: runState({ runHandle: 'hB', skillInstallId: 'app:bank-statement', toolName: 'summarize_cashflow', conversationId: 'convB', documentId: 'docB', state: 'done', transactionCount: 4 })
    }
    const { askDocuments } = baseApi(runs)
    const user = userEvent.setup()
    render(<ChatScreen onNavigate={() => {}} />)
    await selectConversation(user, 'Chat A') // active = convA, but the run is convB's
    await act(async () => {
      await startSkillRun({ skillInstallId: 'app:bank-statement', toolName: 'summarize_cashflow', conversationId: 'convB', documentId: 'docB' })
    })
    // Deterministic negative gate (TS-1): a (wrongly) firing relay effect calls askDocuments
    // SYNCHRONOUSLY — `stream` has no await before the askDocuments call — and every effect for
    // the store update above already flushed inside `act`. One empty act drains any straggler
    // microtask cascade, so "not called by now" is conclusive; the answer waits for convB.
    await act(async () => {})
    expect(askDocuments).not.toHaveBeenCalled()
  })
})

// SKA-18 (skills audit 2026-07-03, U6): a skill picked + kept on the 'new' composer must NOT resurrect
// on a later empty composer (a New chat / mode toggle) after it was carried onto the created
// conversation — else the next send persists a keep opt-in made for conversation 1 onto conversation 2.
describe('ChatScreen — the "new"-composer pick is cleared after being carried (SKA-18)', () => {
  function skill(): SkillInfo {
    return {
      installId: 'app:bank-statement',
      id: 'bank-statement',
      title: 'Bank statement helper',
      description: 'Explains a bank statement.',
      version: '1.0.0',
      kind: 'instruction',
      author: 'You',
      language: 'en',
      source: 'app',
      trustedLevel: 'app',
      enabled: true,
      warningAck: true,
      unavailable: false,
      permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
      permissionSummary: 'x',
      duplicateId: false,
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    } as SkillInfo
  }
  const pickerTrigger = (): HTMLElement => screen.getByRole('button', { name: /^skill:/i })

  it('does not resurrect the kept pick on New chat after the first send carried it to a conversation', async () => {
    const setConversationDefaultSkill = vi.fn(async () => {})
    const created: Conversation = { ...conv({ id: 'conv1', title: 'Created', mode: 'chat', scope: null, scopeDocumentIds: null }) }
    let convList: Conversation[] = []
    stubApi({
      // Empty at first (start on the 'new' composer); the created conversation appears after send so the
      // mode toggle can see the active conversation's (chat) mode and deselect it.
      listConversations: vi.fn(async () => convList),
      getRuntimeStatus: vi.fn(async () => status()),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      listSkills: vi.fn(async () => [skill()]),
      suggestSkills: vi.fn(async () => []),
      listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
      listAttachments: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => ({ dictationAvailable: false })),
      listSkillRuns: vi.fn(async () => []),
      createConversation: vi.fn(async () => {
        convList = [created] // the send's ensureConversation created it
        return created
      }),
      setConversationDefaultSkill,
      sendChatMessage: vi.fn(async () => {}),
      onToken: vi.fn(unsub),
      onReasoning: vi.fn(unsub),
      onScopeNotice: vi.fn(unsub),
      onCompaction: vi.fn(unsub)
    } as unknown as Parameters<typeof stubApi>[0])
    const user = userEvent.setup()
    render(<ChatScreen onNavigate={() => {}} />)
    // Pick the skill + keep it for the conversation, both on the 'new' composer (wait for the async
    // listSkills load so the picker is present).
    await user.click(await screen.findByRole('button', { name: /^skill:/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    await user.click(pickerTrigger())
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /keep for this conversation/i }))
    await user.keyboard('{Escape}') // close the menu (Radix aria-hides the rest of the app while open)
    // Send → ensureConversation creates conv1 and persists the keep for it.
    await user.type(await screen.findByRole('textbox'), 'hello')
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(setConversationDefaultSkill).toHaveBeenCalledWith('conv1', 'app:bank-statement'))
    setConversationDefaultSkill.mockClear()
    // Toggle to the OTHER mode → the active (chat) conversation is deselected, giving a fresh 'new'
    // composer. It must be CLEAN: the carried pick was DELETED from the 'new' keys, not resurrected.
    await user.click(screen.getByRole('radio', { name: /ask my documents/i }))
    await waitFor(() => expect(pickerTrigger()).toHaveTextContent('No skill'))
    // …and it was never re-persisted for any conversation.
    expect(setConversationDefaultSkill).not.toHaveBeenCalledWith(expect.anything(), 'app:bank-statement')
  })

  // full-audit 2026-07-11 CODE-30: "+ New chat" used to BYPASS the SKA-18 carry+delete block (it
  // only ran inside ensureConversation, i.e. on a SEND) — a composer pick silently vanished from
  // the created chat and then resurrected on the next empty composer.
  it('"+ New chat" carries the composer pick onto the created conversation and cleans the "new" keys (CODE-30)', async () => {
    const setConversationDefaultSkill = vi.fn(async () => {})
    const created: Conversation = { ...conv({ id: 'conv1', title: 'Created', mode: 'chat', scope: null, scopeDocumentIds: null }) }
    let convList: Conversation[] = []
    stubApi({
      listConversations: vi.fn(async () => convList),
      getRuntimeStatus: vi.fn(async () => status()),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      listSkills: vi.fn(async () => [skill()]),
      suggestSkills: vi.fn(async () => []),
      listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
      listAttachments: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => ({ dictationAvailable: false })),
      listSkillRuns: vi.fn(async () => []),
      createConversation: vi.fn(async () => {
        convList = [created]
        return created
      }),
      setConversationDefaultSkill,
      onToken: vi.fn(unsub),
      onReasoning: vi.fn(unsub),
      onScopeNotice: vi.fn(unsub),
      onCompaction: vi.fn(unsub)
    } as unknown as Parameters<typeof stubApi>[0])
    const user = userEvent.setup()
    render(<ChatScreen onNavigate={() => {}} />)
    // Pick + keep on the 'new' composer (no send).
    await user.click(await screen.findByRole('button', { name: /^skill:/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    await user.click(pickerTrigger())
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /keep for this conversation/i }))
    await user.keyboard('{Escape}')
    // "+ New chat" — the CODE-30 entry point. Pre-fix: no carry ran, so the pick vanished (the
    // picker read "No skill" for the created conversation) and the kept default was never persisted.
    await user.click(screen.getByRole('button', { name: '+ New chat' }))
    await waitFor(() => expect(setConversationDefaultSkill).toHaveBeenCalledWith('conv1', 'app:bank-statement'))
    expect(pickerTrigger()).toHaveTextContent('Bank statement helper')
    setConversationDefaultSkill.mockClear()
    // …and the 'new' keys were DELETED: deselect via the mode toggle → the fresh composer is clean
    // (pre-fix the leftover 'new' key resurrected the pick here).
    await user.click(screen.getByRole('radio', { name: /ask my documents/i }))
    await waitFor(() => expect(pickerTrigger()).toHaveTextContent('No skill'))
    expect(setConversationDefaultSkill).not.toHaveBeenCalledWith(expect.anything(), 'app:bank-statement')
  })

  // CODE-30 rider: ConversationList's `onClick={onNew}` discards the promise — a failed
  // createConversation used to be an unhandled rejection with zero feedback.
  it('a failed "+ New chat" surfaces on the error banner (CODE-30)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => status()),
      listMessages: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      listSkills: vi.fn(async () => [] as SkillInfo[]),
      suggestSkills: vi.fn(async () => []),
      listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
      listAttachments: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => ({ dictationAvailable: false })),
      listSkillRuns: vi.fn(async () => []),
      createConversation: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'chat:createConversation': Error: The workspace is locked. Unlock it to continue."
        )
      }),
      onToken: vi.fn(unsub),
      onReasoning: vi.fn(unsub),
      onScopeNotice: vi.fn(unsub),
      onCompaction: vi.fn(unsub)
    } as unknown as Parameters<typeof stubApi>[0])
    const user = userEvent.setup()
    render(<ChatScreen onNavigate={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '+ New chat' }))
    // Pre-fix: an unhandled rejection (vitest fails on it) and no banner.
    expect(await screen.findByText(/workspace is locked/i)).toBeInTheDocument()
  })
})
