// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ContextUsage, Conversation, Message } from '../../src/shared/types'
import type { CompactionNotice } from '../../src/shared/ipc'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { chatScreenStubs, conversationRow, deferred, fakeChatStream, renderChatScreen } from '../helpers/chat-screen'
import { assistantMsg, makeConversation, userMsg } from '../helpers/chat-fixtures'
import { t } from '../../src/shared/i18n'

// Phase 2 UX (context-compaction plan §5.1–§5.3), the screen wiring: the selected conversation's usage
// read reaches the composer's memory meter (its copy is ContextMeter.test.tsx's) and climbs while an answer
// streams, the transcript summary marker sits before the first turn the checkpoint does not subsume, and the
// one-shot "working on it" notice shows by kind and clears on the first answer token. The other one-shot
// per-send notice, the filename auto-scope toast, sits here too.

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
  }
})

/** Wait for the conversation list, then select `title`. */
async function selectConversation(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await screen.findByText(title)
  await user.click(conversationRow(title))
}

describe('ChatScreen — context-usage meter (§5.1)', () => {
  it("shows the selected conversation's usage read on the memory meter", async () => {
    const user = userEvent.setup()
    // 6.4k / 8k = 80%.
    const getConversationContextUsage = vi.fn(
      async (): Promise<ContextUsage | null> => ({ usedTokens: 6400, window: 8000 })
    )
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Compaction chat' })]),
        getConversationContextUsage
      })
    )
    renderChatScreen()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument() // no conversation, no reading
    await selectConversation(user, 'Compaction chat')

    // #25/D69: a conversation-MEMORY gauge (role="meter"), not a progress bar. Its label and tooltip
    // copy (the token figures, the amber will-summarize heads-up) are ContextMeter.test.tsx's.
    expect(await screen.findByRole('meter')).toHaveAttribute('aria-valuenow', '80')
    expect(getConversationContextUsage).toHaveBeenCalledWith('c1')
  })

  // #743: while THIS conversation's answer streams, the meter climbs on top of the resting read. Until main
  // reports the turn's real assembled prompt it adds an estimate of the question; that report then replaces
  // the base (it already holds the question, and a document turn's excerpts); the streamed answer's estimate
  // rides on top. The estimate is ⌈words × 1.95⌉ + 8 per turn (ChatScreen's `liveTokensFromWords`, mirroring
  // chat.ts `messageTokens`). A 100-token window makes the percentage the token count.
  it('climbs while an answer streams, then settles on the resting read main reports after the turn', async () => {
    const user = userEvent.setup()
    const stream = fakeChatStream()
    const reply = deferred<Message>()
    let resting: ContextUsage = { usedTokens: 40, window: 100 }
    stubApi(
      chatScreenStubs({
        ...stream.stubs,
        listConversations: vi.fn(async () => [makeConversation({ title: 'Compaction chat' })]),
        getConversationContextUsage: vi.fn(async () => resting),
        sendChatMessage: vi.fn(() => reply.promise)
      })
    )
    renderChatScreen()
    await selectConversation(user, 'Compaction chat')
    expect(await screen.findByRole('meter')).toHaveAttribute('aria-valuenow', '40')

    await user.type(screen.getByPlaceholderText('Message…'), 'one two three four five six seven eight nine ten')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(stream.subscribed()).toBe(true))
    // The question's estimate: 40 + (⌈10 × 1.95⌉ + 8 = 28).
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '68')

    // Main's real prompt usage replaces the base; the question is in it, so it is not added again.
    stream.contextUsage({ usedTokens: 50, window: 100 })
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '50')

    // A streamed one-word answer: 50 + (⌈1 × 1.95⌉ + 8 = 10), once the buffered token is painted.
    stream.token('Paris')
    await waitFor(() => expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '60'))

    // The turn settles: the live figures go, and the meter shows main's fresh resting read.
    resting = { usedTokens: 70, window: 100 }
    await act(async () => reply.resolve(assistantMsg('a9', 'Paris')))
    await waitFor(() => expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '70'))
  })
})

// #743: the filename auto-scope notice (rag §10.1 rule 5). A documents question that names an indexed file is
// answered from that file alone, and main says so once, before the first token (registerRagIpc, STREAM.scope).
// Main sends it only when the question matched a file, never with an empty list (`detectFilenameScope` answers
// null instead), so the screen's empty-list guard has no row.
describe('ChatScreen — the filename auto-scope notice', () => {
  it('toasts every file a documents answer was narrowed to', async () => {
    const user = userEvent.setup()
    const stream = fakeChatStream()
    const reply = deferred<Message>()
    stubApi(
      chatScreenStubs({
        ...stream.stubs,
        listConversations: vi.fn(async () => [
          makeConversation({ title: 'Doc chat', mode: 'documents', scope: { collectionIds: [], documentIds: [] } })
        ]),
        askDocuments: vi.fn(() => reply.promise)
      })
    )
    renderChatScreen()
    await selectConversation(user, 'Doc chat')
    await user.type(screen.getByPlaceholderText(/ask about your documents/i), 'compare a.pdf and b.pdf')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(stream.subscribed()).toBe(true))

    stream.scopeNotice({ titles: ['a.pdf', 'b.pdf'] })
    expect(await screen.findByText(t('en', 'chat.scopeNotice', { titles: 'a.pdf, b.pdf' }))).toBeInTheDocument()

    await act(async () => reply.resolve(assistantMsg('a9', 'done')))
  })
})

describe('ChatScreen — transcript summary marker (§5.3, D-b)', () => {
  it('renders the marker before the boundary message and expands to the summary text', async () => {
    const user = userEvent.setup()
    stubApi(
      chatScreenStubs({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Compaction chat' })]),
        listMessages: vi.fn(async () => [userMsg('m1', 'question one'), assistantMsg('m2', 'answer one')]),
        getConversationSummary: vi.fn(async () => ({
          summary: 'SUMMARYBODY goal and facts',
          beforeMessageId: 'm2'
        }))
      })
    )
    renderChatScreen()
    await selectConversation(user, 'Compaction chat')

    const toggle = await screen.findByRole('button', { name: /earlier messages summarized/i })
    // §5.3: the divider sits just before the first turn the checkpoint does NOT subsume (m2) — after m1,
    // before m2.
    expect(screen.getByText('question one').compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(toggle.compareDocumentPosition(screen.getByText('answer one')) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(screen.queryByText(/SUMMARYBODY/)).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByText(/SUMMARYBODY/)).toBeInTheDocument()
  })
})

/** One row of the notice table: the conversation's mode picks the send channel main emits the kind on. */
interface NoticeRow {
  mode: Conversation['mode']
  notice: CompactionNotice
  placeholder: string | RegExp
  sendLabel: string
  shows: RegExp
  never: RegExp
}

describe('ChatScreen — the "working on it" notice (§5.2, U5)', () => {
  // U5 (audit §3.6): the SAME ephemeral channel carries an 'analysis' notice when a long, silent
  // whole-document read starts — shown with honest "reading the document…" copy (NOT the compaction
  // "summarizing…" line), and cleared on the first answer token exactly the same way. Main sends each kind
  // only on its own path: a bare compaction start from registerChatIpc (plain chat), 'analysis' from
  // registerRagIpc / whole-doc-tree.ts (a documents ask).
  // [title, row] tuples titled with `%s`: vitest quotes an object row's `$label` and cuts it at 40 characters.
  it.each<[string, NoticeRow]>([
    [
      'the summarizing notice on a compaction start (plain chat)',
      {
        mode: 'chat',
        notice: { phase: 'start' },
        placeholder: 'Message…',
        sendLabel: 'Send',
        shows: /summarizing earlier messages/i,
        never: /reading the whole document/i
      }
    ],
    [
      'the reading-the-document notice on an analysis start (documents chat)',
      {
        mode: 'documents',
        notice: { phase: 'start', kind: 'analysis' },
        placeholder: /ask about your documents/i,
        sendLabel: 'Ask',
        shows: /reading the whole document/i,
        never: /summarizing earlier messages/i
      }
    ]
  ])('shows %s and clears it on the first answer token', async (_label, row) => {
    const { mode, notice, placeholder, sendLabel, shows, never } = row
    const user = userEvent.setup()
    const stream = fakeChatStream()
    const reply = deferred<Message>()
    const sendChatMessage = vi.fn(() => reply.promise)
    const askDocuments = vi.fn(() => reply.promise)
    stubApi(
      chatScreenStubs({
        ...stream.stubs,
        listConversations: vi.fn(async () => [makeConversation({ title: 'Compaction chat', mode })]),
        sendChatMessage,
        askDocuments
      })
    )
    renderChatScreen()
    await selectConversation(user, 'Compaction chat')
    await user.type(screen.getByPlaceholderText(placeholder), 'hi')
    await user.click(screen.getByRole('button', { name: sendLabel }))

    // The stream is in flight (the send is pending) and its subscriptions are registered.
    await waitFor(() => expect(stream.subscribed()).toBe(true))
    // The notice rides the path main sends it on: plain chat's send, or the documents ask.
    expect(sendChatMessage).toHaveBeenCalledTimes(mode === 'chat' ? 1 : 0)
    expect(askDocuments).toHaveBeenCalledTimes(mode === 'documents' ? 1 : 0)
    stream.compaction(notice)
    expect(await screen.findByText(shows)).toBeInTheDocument()
    expect(screen.queryByText(never)).not.toBeInTheDocument()

    // The first answer token clears the notice.
    stream.token('hello')
    await waitFor(() => expect(screen.queryByText(shows)).not.toBeInTheDocument())

    await act(async () => reply.resolve(assistantMsg('a9', 'done')))
  })
})
