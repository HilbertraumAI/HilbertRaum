// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DOC_TASK_BUSY_MESSAGE, type Conversation, type Message } from '../../src/shared/types'
import type { PreloadApi } from '../../src/preload'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { chatScreenStubs, conversationRow, deferred, flushFakeTimers, renderChatScreen } from '../helpers/chat-screen'
import { assistantMsg, makeConversation, userMsg } from '../helpers/chat-fixtures'
import { runtimeStatus } from '../helpers/status'
import { t } from '../../src/shared/i18n'
import { RUNTIME_POLL_MS } from '../../src/renderer/lib/polling'
import { clearDocTaskSession, startTask } from '../../src/renderer/lib/doctasks'

// CR-1 (audit chat-docs-2026-07-07): a send that fails BEFORE the user turn persists (document-task
// busy, no model, a slot held by another window) used to lose both the composer text and the
// optimistic bubble — precisely when the banner invites a retry. The fix keeps the responsive early
// setInput('') but restores the draft into a still-empty composer when the turn did not persist.
// (CR-2, the transcript re-pin on a conversation switch, lives in ChatSwitchStop.test.tsx.)

afterEach(() => {
  assertNoUnexpectedApiCalls()
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.clear()
})

/** Common stub for a working chat screen with one conversation ('Chat 1'); the send is the test's. */
function baseStub(over: Partial<PreloadApi> = {}): void {
  stubApi(
    chatScreenStubs({ listConversations: vi.fn(async () => [makeConversation({ title: 'Chat 1' })]), ...over })
  )
}

/** One CR-1 row: what the failed send throws, the history the failure refresh reads, and what follows. */
interface DraftRestoreRow {
  error: string
  history: Message[]
  typed: string
  /** The composer's value after the failure. */
  composer: string
  /** The banner's copy, when one shows. */
  banner: RegExp | null
  /** A persisted question the transcript shows exactly once. */
  shownOnce: string | null
}

describe('ChatScreen — draft restore on pre-persist send failure (CR-1)', () => {
  // Whether the draft comes back is decided by the persisted TAIL the failure refresh reads:
  //  - a guard reject before the turn is written (empty history) refills the composer and shows the
  //    banner (teeth: delete `restoreDraft` → the composer stays '');
  //  - a failed send that still persisted the user turn keeps the composer empty, so a restore cannot
  //    invite a duplicate re-send (teeth: drop the tail compare → it refills);
  //  - full-audit 2026-07-11 CODE-40: the check used to be `persisted.some(content ===)`, so a REPEATED
  //    question matched the OLD turn and a busy-rejected re-ask was silently lost (no restore, no bubble).
  //    It now compares against the TAIL: a send that persisted its user turn leaves the conversation
  //    ENDING in that turn when the catch runs (teeth: revert to `some(content ===)` → row 3 reads '').
  // [title, row] tuples titled with `%s`: vitest quotes an object row's `$label` and cuts it at 40 characters.
  it.each<[string, DraftRestoreRow]>([
    [
      'refills the composer and shows the banner when a send fails before the user turn persists',
      {
        error: DOC_TASK_BUSY_MESSAGE,
        history: [],
        typed: 'a long typed question',
        composer: 'a long typed question',
        banner: /document task/i,
        shownOnce: null
      }
    ],
    [
      'does NOT restore when the failed send still persisted the user turn (no duplicate)',
      // E.g. a socket drop mid-stream: the user turn WAS written, so the failure refresh lists it.
      {
        error: 'stream failed',
        history: [userMsg('u1', 'persisted question')],
        typed: 'persisted question',
        composer: '',
        banner: null,
        shownOnce: 'persisted question'
      }
    ],
    [
      'restores the draft when a REPEATED question is busy-rejected before it persists (CODE-40)',
      // The SAME question was asked and answered earlier; the refresh returns that history (tail = assistant).
      {
        error: DOC_TASK_BUSY_MESSAGE,
        history: [userMsg('u1', 'x'), assistantMsg('a1', 'answer to x')],
        typed: 'x',
        composer: 'x',
        banner: /document task/i,
        shownOnce: null
      }
    ]
  ])('%s', async (_label, { error, history, typed, composer, banner, shownOnce }) => {
    vi.useFakeTimers()
    try {
      const sendChatMessage = vi.fn(async (): Promise<Message> => {
        throw new Error(error)
      })
      baseStub({ listMessages: vi.fn(async () => history), sendChatMessage })

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: typed } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()

      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe(composer)
      if (banner) expect(screen.getByRole('alert').textContent ?? '').toMatch(banner)
      // The persisted question shows exactly once, in the transcript (no optimistic copy beside it).
      if (shownOnce) expect(screen.getAllByText(shownOnce)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps newer in-flight typing (the cur === "" guard) instead of clobbering it', async () => {
    vi.useFakeTimers()
    try {
      // The send parks until we release it as a rejection, so we can type again mid-flight.
      const send = deferred<Message>()
      const sendChatMessage = vi.fn(() => send.promise)
      baseStub({ listMessages: vi.fn(async () => []), sendChatMessage })

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()

      const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: 'hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()
      // The early setInput('') cleared it; the user types a NEW draft while the send is in flight.
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'world' } })

      // Now the send fails pre-persist — the restore must NOT overwrite the newer 'world'.
      await act(async () => send.reject(new Error('no model running')))
      await flushFakeTimers()

      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('world')
    } finally {
      vi.useRealTimers()
    }
  })

  // CODE-40 follow-up (review): the try also spans the two POST-send refreshes — a fully
  // successful send whose refreshConversations then throws lands in the same catch with the
  // persisted tail being the ASSISTANT reply. The bare tail compare misread that as "turn never
  // persisted" and restored the already-answered question (a duplicate-re-send invitation);
  // the `sendSucceeded` latch scopes the compare to send FAILURES.
  it('does NOT restore the draft when the send succeeded but a post-send refresh throws (CODE-40 follow-up)', async () => {
    vi.useFakeTimers()
    try {
      // The send itself SUCCEEDS, resolving the persisted assistant reply.
      const sendChatMessage = vi.fn(async () => assistantMsg('a1', 'the answer'))
      const listConversations = vi
        .fn<() => Promise<Conversation[]>>()
        .mockResolvedValueOnce([makeConversation({ title: 'Chat 1' })]) // mount refresh
        .mockRejectedValue(new Error('list failed after send')) // the post-send refresh throws
      baseStub({
        listConversations,
        // The persisted truth after the successful send: question + fresh answer (tail = assistant).
        listMessages: vi.fn(async () => [userMsg('u1', 'quantum question'), assistantMsg('a1', 'the answer')]),
        sendChatMessage
      })

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()

      fireEvent.change(screen.getByPlaceholderText('Message…'), {
        target: { value: 'quantum question' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()

      // TEETH: without the latch the assistant tail reads as "not persisted" → the composer
      // refills with the ALREADY-ANSWERED question (one Enter away from a duplicate turn).
      expect((screen.getByPlaceholderText('Message…') as HTMLTextAreaElement).value).toBe('')
      // The question shows exactly once, in the transcript — no duplicate vector anywhere.
      expect(screen.getAllByText('quantum question')).toHaveLength(1)
      // The refresh failure itself still surfaces (never silent).
      expect(screen.getByRole('alert').textContent ?? '').toMatch(/list failed after send/)
    } finally {
      vi.useRealTimers()
    }
  })
})

// The busy banner (D26): a send refused because a document task holds the lane shows the shared
// copy with a "Cancel document task" button.
describe('ChatScreen — the document-task busy banner and its cancel (D26)', () => {
  afterEach(() => clearDocTaskSession())

  /** Send into a busy refusal, then click the banner's cancel. */
  async function sendRefusedThenCancel(): Promise<void> {
    renderChatScreen()
    await flushFakeTimers()
    fireEvent.click(conversationRow('Chat 1'))
    await flushFakeTimers()
    fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'q' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await flushFakeTimers()
    expect(screen.getByRole('alert').textContent ?? '').toMatch(/document task/i)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel document task' }))
    await flushFakeTimers()
  }

  const busySend = (): (() => Promise<never>) =>
    vi.fn(async () => {
      throw new Error(DOC_TASK_BUSY_MESSAGE)
    })

  // #689: chat is refused while ANY task holds the lane, so the banner cancels the running one with
  // no id, whichever screen started it. The Documents store's task may be queued behind it;
  // cancelling that one by its id would leave chat refused.
  it('cancels the running task with no id, even while the Documents screen holds a task, and clears', async () => {
    vi.useFakeTimers()
    try {
      const cancelDocTask = vi.fn(async () => {})
      baseStub({
        listMessages: vi.fn(async () => []),
        sendChatMessage: busySend(),
        startDocTask: vi.fn(async () => ({ jobId: 'documents-task' })),
        cancelDocTask
      })
      await startTask('summary', 'd2')

      await sendRefusedThenCancel()

      expect(cancelDocTask).toHaveBeenCalledTimes(1)
      expect(cancelDocTask).toHaveBeenCalledWith()
      expect(screen.queryByText(/A document task is running/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // full-audit 2026-07-11 CODE-39 (ChatScreen fold): the button had an explicit
  // `.catch(() => undefined)` — a REJECTED cancel left the banner up with zero feedback. The failure
  // now lands on the same banner.
  it('shows a rejected cancel instead of swallowing it (CODE-39)', async () => {
    vi.useFakeTimers()
    try {
      const cancelDocTask = vi.fn(async () => {
        throw new Error("Error invoking remote method 'docs:cancelTask': Error: cancel exploded")
      })
      baseStub({ listMessages: vi.fn(async () => []), sendChatMessage: busySend(), cancelDocTask })

      await sendRefusedThenCancel()

      // TEETH: with the old no-op catch the banner keeps the busy copy and the failure vanishes.
      expect(cancelDocTask).toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent ?? '').toMatch(/cancel exploded/)
    } finally {
      vi.useRealTimers()
    }
  })
})

// RD-1 (full-audit 2026-07-10): on the FIRST send of a brand-new conversation, the history-load
// effect fires DURING ensureConversation's await — its listMessages reaches main BEFORE the send
// IPC, main answers [], and that [] lands AFTER the optimistic append, wiping the user's bubble
// for the whole first answer (the CR-7 activeIdRef guard passes: it IS the active conversation).
describe('ChatScreen — first send keeps the optimistic bubble (RD-1)', () => {
  it('a history [] that resolves only after the send IPC does not wipe the first user bubble', async () => {
    vi.useFakeTimers()
    try {
      // The exact production interleave, made deterministic: the history read parks until the
      // send IPC has been invoked, then answers [] — so without the guard the [] always lands
      // after the optimistic append. The send itself stays in flight (a streaming first answer).
      const history = deferred<void>()
      const listMessages = vi.fn(async (): Promise<Message[]> => {
        await history.promise
        return []
      })
      const sendChatMessage = vi.fn(() => {
        history.resolve()
        return new Promise<Message>(() => {})
      })
      const created: Conversation[] = []
      baseStub({
        listConversations: vi.fn(async () => created),
        createConversation: vi.fn(async () => {
          const conv = makeConversation({ id: 'c-new', title: 'New chat' })
          created.push(conv)
          return conv
        }),
        listMessages,
        sendChatMessage
      })

      renderChatScreen()
      await flushFakeTimers()

      // No conversation selected — the send goes through ensureConversation (the racy path).
      const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: 'first question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()

      // Teeth: the send is in flight and every parked microtask has settled — without the guard
      // the gated [] has already replaced the transcript and the bubble is gone.
      expect(sendChatMessage).toHaveBeenCalled()
      expect(screen.getByText('first question')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

// #599: a refusal about the model's state ("…is starting", "No AI model is running…") used to sit over
// the composer after the model came back. It now goes when the model returns; any other error stays —
// the crash's own message explains why the question has no answer. The waiting screen in between says
// the model is starting (its title used to read "No model is running" above "Your model is starting").
describe('ChatScreen — a "model is starting" refusal clears once the model is back (#599)', () => {
  // `startingReads`: how many status reads after the refusal still find the model starting — one (the
  // waiting screen, then back on the next poll) or none (a quick restart is over by the re-read).
  it.each([
    ['the starting refusal clears once the model is back', t('en', 'main.modelStarting'), 1, false],
    ['the starting refusal clears when the model is already back', t('en', 'main.modelStarting'), 0, false],
    ['a crash message stays', t('en', 'main.chat.connectionLost'), 1, true]
  ])('%s', async (_label, refusal, startingReads, stays) => {
    vi.useFakeTimers()
    try {
      let starting = 0
      const getRuntimeStatus = vi.fn(async () => {
        if (starting === 0) return runtimeStatus() // IPC hands back a fresh copy per read
        starting-- // the following read finds the model back
        return runtimeStatus({
          running: false,
          modelId: null,
          port: null,
          healthy: false,
          message: 'Stopped',
          startRequested: true
        })
      })
      const sendChatMessage = vi.fn(async (): Promise<Message> => {
        starting = startingReads // a CPU crash restart is under way
        throw new Error(refusal)
      })
      baseStub({ listMessages: vi.fn(async () => []), sendChatMessage, getRuntimeStatus })

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()

      if (startingReads > 0) {
        // The post-failure re-read finds the model starting: the waiting screen says so.
        expect(screen.getByText(t('en', 'chat.noModel.startingTitle'))).toBeInTheDocument()
        expect(screen.queryByText(t('en', 'chat.noModel.title'))).not.toBeInTheDocument()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS)
        })
        await flushFakeTimers()
      }
      expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument() // the model is back
      const alerts = screen.queryAllByRole('alert').map((el) => el.textContent ?? '').join(' ')
      if (stays) expect(alerts).toContain(refusal)
      else expect(alerts).not.toContain(refusal)
    } finally {
      vi.useRealTimers()
    }
  })
})

// #613: a question an error, a crash or an early stop left without an answer used to be a dead end —
// "Try again" exists only on answers, the banner offers no retry, and the user had to retype it. "Send
// again" under the question asks it again with one click; main answers the stored question, so the
// screen must not add a second copy of it (no optimistic bubble), in either mode.
describe('ChatScreen — "Send again" on a question that got no answer (#613)', () => {
  const sendAgain = (): HTMLElement | null => screen.queryByRole('button', { name: /Send again/ })

  it('after a crash, one click asks the same question again — shown once, the crash banner gone', async () => {
    vi.useFakeTimers()
    try {
      let history: Message[] = []
      const resend = deferred<Message>()
      const sendChatMessage = vi
        .fn<PreloadApi['sendChatMessage']>()
        // The first send persists the question, then the model crashes under it.
        .mockImplementationOnce(async () => {
          history = [userMsg('u1', 'the question')]
          throw new Error(t('en', 'main.chat.connectionLost'))
        })
        // The resend parks mid-answer, so the screen can be read while it streams.
        .mockImplementationOnce(() => resend.promise)
      baseStub({ listMessages: vi.fn(async () => history), sendChatMessage })

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'the question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()
      expect(screen.getByRole('alert').textContent).toContain(t('en', 'main.chat.connectionLost'))

      fireEvent.click(sendAgain()!)
      await flushFakeTimers()
      expect(sendChatMessage).toHaveBeenLastCalledWith('c1', '', { mode: 'balanced', resendMessageId: 'u1' })
      // Mid-answer: the question is on screen once, its button gone, the crash banner cleared.
      expect(screen.getAllByText('the question')).toHaveLength(1)
      expect(sendAgain()).toBeNull()
      expect(screen.getByRole('alert').textContent).not.toContain(t('en', 'main.chat.connectionLost'))

      await act(async () => {
        history = [...history, assistantMsg('a1', 'the answer')]
        resend.resolve(history[1])
      })
      await flushFakeTimers()
      expect(screen.getAllByText('the question')).toHaveLength(1)
      expect(sendAgain()).toBeNull() // an answer follows the question now
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers nothing under a bubble main never stored (the send failed and so did the refresh)', async () => {
    vi.useFakeTimers()
    try {
      let refreshFails = false
      const sendChatMessage = vi.fn(async (): Promise<Message> => {
        refreshFails = true // the failure refresh below rejects too, so the optimistic bubble stays
        throw new Error(DOC_TASK_BUSY_MESSAGE)
      })
      const listMessages = vi.fn(async (): Promise<Message[]> => {
        if (refreshFails) throw new Error('Workspace is locked. Unlock it to chat.')
        return []
      })
      baseStub({ listMessages, sendChatMessage })

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Chat 1'))
      await flushFakeTimers()
      fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'never stored' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await flushFakeTimers()

      expect(screen.getByText('never stored')).toBeInTheDocument() // the optimistic bubble stays
      expect(sendAgain()).toBeNull() // main would refuse its id: it has no such question
    } finally {
      vi.useRealTimers()
    }
  })

  it('in a documents chat it asks through the documents channel, by the question id', async () => {
    vi.useFakeTimers()
    try {
      // E.g. reopened after a reload: the question is there, its error banner long gone.
      const askDocuments = vi.fn(() => new Promise<Message>(() => {}))
      const sendChatMessage = vi.fn<PreloadApi['sendChatMessage']>()
      baseStub({
        listConversations: vi.fn(async () => [makeConversation({ title: 'Doc chat 1', mode: 'documents' })]),
        listMessages: vi.fn(async () => [userMsg('u1', 'what are the payment terms')]),
        askDocuments,
        sendChatMessage
      })

      renderChatScreen()
      await flushFakeTimers()
      fireEvent.click(conversationRow('Doc chat 1'))
      await flushFakeTimers()
      fireEvent.click(sendAgain()!)
      await flushFakeTimers()

      expect(askDocuments).toHaveBeenCalledWith('c1', '', undefined, false, undefined, 'u1')
      expect(sendChatMessage).not.toHaveBeenCalled()
      expect(screen.getAllByText('what are the payment terms')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// CH-14 (frontend audit 2026-08-09, #148; moved here from ChatLowsBundle by the chat-ui test campaign):
// `busyStreaming` flips only after ensureConversation's round trips resolve, so a second submit in that
// window used to mint a DUPLICATE conversation. The synchronous `sendInFlightRef` refuses the re-entry.
describe('ChatScreen — double-submit guard (CH-14, #148)', () => {
  it('a second Send click during ensureConversation creates NO duplicate conversation', async () => {
    const created = deferred<Conversation>()
    const createConversation = vi.fn(() => created.promise)
    const sendChatMessage = vi.fn(async () => assistantMsg('a1', 'ok'))
    stubApi(chatScreenStubs({ createConversation, sendChatMessage })) // listConversations → [] (none yet)
    const user = userEvent.setup()
    renderChatScreen()
    await user.type(await screen.findByRole('textbox'), 'hello')
    const send = screen.getByRole('button', { name: /^send$/i })
    // Both submits land while createConversation is still in flight — before busyStreaming can flip.
    await act(async () => {
      fireEvent.click(send)
      fireEvent.click(send)
    })
    await act(async () => created.resolve(makeConversation({ title: 'New chat' })))
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1))
    expect(createConversation).toHaveBeenCalledTimes(1)
  })
})
