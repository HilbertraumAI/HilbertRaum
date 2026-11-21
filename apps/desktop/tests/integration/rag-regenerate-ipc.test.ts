import { describe, it, expect, vi, beforeEach } from 'vitest'

// F2 (post-merge audit) — the RAG channel mirror of the chat regenerate data-loss fix.
// `askDocuments(regenerate:true)` used to DELETE the prior assistant reply (committed,
// node:sqlite is synchronous) BEFORE the stream slot was claimed, so a non-abort generation
// failure (a context-exceeded 400, a dead sidecar) destroyed the previous answer with nothing
// in its place. The destructive delete is now deferred into the stream's runFn (slot held) and
// the prior reply is RESTORED on a non-abort failure. Drives the real IPC handler with a faked
// transport (tests/helpers/ipc.ts); a real temp DB + mock embedder run underneath.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { IPC } from '../../src/shared/ipc'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { appendMessage, createConversation, listMessages } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { seedEmbeddedDoc } from '../helpers/doc-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { regenWorkspace } from '../helpers/regenerate-fixtures'
import { failingRuntime, scriptedRuntime, type ScriptedCall } from '../helpers/scripted-runtime'
import { makeRagAskContext } from '../helpers/skills-world'
import { t } from '../../src/shared/i18n'
import type { Message } from '../../src/shared/types'
import { endedEarlyAbortReason } from '../../src/main/services/chat/ended-early'
import type { ModelRuntime } from '../../src/main/services/runtime'

const handlers = ipcState.handlers as unknown as IpcHandlers

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('askDocuments regenerate — F2 data-loss guard', () => {
  // F2 (post-merge audit): the restore leg itself, on the documents channel.
  // #132/#135 (skills-pipeline audit): the F2 restore must carry the persisted #80 skill OFFER too.
  // The snapshot's explicit column list omitted `skill_offer_json`, so on BOTH restore legs (a
  // non-abort failure here; a Stop before the first token) the reply came back with its offer
  // permanently stripped and the offer row silently vanished — structurally the same bug the
  // result_tables capture fixed.
  it('a failed regenerate restores the prior reply WITH its skill offer intact', async () => {
    const w = regenWorkspace('ragregen')
    const { db } = w
    const embedder = new MockEmbedder()
    const question = 'kategorisiere alle transaktionen'
    const docId = await seedEmbeddedDoc(db, embedder, 'statement.pdf', [question])
    const conv = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [docId] }
    })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: question })
    const prior = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'the listing answer',
      skillOffer: { installId: 'app:bank-statement', title: 'Bank Statement Analysis', source: 'deterministic' }
    })
    expect(prior.skillOffer).toBeTruthy()

    registerRagIpc(makeRagAskContext(w, failingRuntime()).ctx)
    await expect(
      invoke(handlers, IPC.askDocuments, conv.id, question, null, /* regenerate */ true)
    ).rejects.toThrow(/HTTP 400|too large/i)

    // F2 + #132: the prior answer is restored byte-faithfully — same id, content and offer — and the slot is released.
    const history = listMessages(db, conv.id)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    const restored = history.at(-1)
    expect(restored?.id).toBe(prior.id)
    expect(restored?.content).toBe('the listing answer')
    expect(restored?.skillOffer).toEqual({
      installId: 'app:bank-statement',
      title: 'Bank Statement Analysis',
      source: 'deterministic'
    })
    expect(inFlightStreams.has(conv.id)).toBe(false)
  })
})

// #613 "Send again" — the documents channel's twin of chat's resend (its own branch in the handler):
// the stored question is the question, so retrieval and the model get it, and nothing is appended.
describe('askDocuments "Send again" (#613)', () => {
  async function unansweredDocumentQuestion(): Promise<ReturnType<typeof regenWorkspace> & { convId: string; questionId: string }> {
    const w = regenWorkspace('ragregen')
    const { db } = w
    const question = 'what are the payment terms'
    const docId = await seedEmbeddedDoc(db, new MockEmbedder(), 'contract.pdf', [question])
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    const q = appendMessage(db, { conversationId: conv.id, role: 'user', content: question })
    return { ...w, convId: conv.id, questionId: q.id }
  }

  it('answers the unanswered last question from the documents — no second copy', async () => {
    const w = await unansweredDocumentQuestion()
    const { db, convId, questionId } = w
    const calls: ScriptedCall[] = []
    registerRagIpc(makeRagAskContext(w, scriptedRuntime('Net 30 days.', calls)).ctx)

    const { result } = await invoke(handlers, IPC.askDocuments, convId, '', null, false, undefined, questionId)

    // Retrieval ran on the stored question (the answer cites the document), and the model got it.
    expect((result as Message).citations?.map((c) => c.sourceTitle)).toEqual(['contract.pdf'])
    expect(calls).toHaveLength(1)
    expect(String(calls[0].messages.at(-1)?.content)).toContain('what are the payment terms')
    const history = listMessages(db, convId)
    expect(history.map((m) => [m.role, m.id === questionId])).toEqual([
      ['user', true],
      ['assistant', false]
    ])
  })

  it('refuses a question that is no longer the last message — nothing streams, nothing is written', async () => {
    const w = await unansweredDocumentQuestion()
    const { db, convId, questionId } = w
    appendMessage(db, { conversationId: convId, role: 'assistant', content: 'answered meanwhile' })
    const calls: ScriptedCall[] = []
    registerRagIpc(makeRagAskContext(w, scriptedRuntime('never', calls)).ctx)
    const before = listMessages(db, convId)

    await expect(
      invoke(handlers, IPC.askDocuments, convId, '', null, false, undefined, questionId)
    ).rejects.toThrow(t('en', 'main.chat.nothingToResend'))

    expect(calls).toHaveLength(0)
    expect(listMessages(db, convId)).toEqual(before)
  })
})

// #963 — small talk in a documents chat gets the short small-talk reply (`generateSmallTalkReply`), and it runs through
// the same stream, regenerate guard and chat slot as every answer: a Stop keeps the partial, marked "Reply stopped"; a
// failure before any token leaves the message unanswered for "Send again", which answers it with no second copy; a
// failed regenerate brings the previous reply back. Each row also checks that the model got the message alone (the
// reply path, not the passage search, which the seeded chunk would feed).
describe('askDocuments small talk through the stream wrappers (#963)', () => {
  const MESSAGE = 'Danke!'

  async function smallTalkChat(): Promise<ReturnType<typeof regenWorkspace> & { convId: string }> {
    const w = regenWorkspace('ragsmalltalk')
    const docId = await seedEmbeddedDoc(w.db, new MockEmbedder(), 'contract.pdf', ['Danke! Vielen Dank für Ihre Zusammenarbeit.'])
    const conv = createConversation(w.db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    return { ...w, convId: conv.id }
  }
  const sentAlone = (call: ScriptedCall): boolean =>
    call.messages.length === 2 && call.messages[0].role === 'system' && call.messages[1].content === MESSAGE

  it('a Stop mid-reply keeps the partial, marked "Reply stopped"', async () => {
    const w = await smallTalkChat()
    const calls: ScriptedCall[] = []
    const runtime: ModelRuntime = {
      ...scriptedRuntime('unused'),
      async *chatStream(messages, options) {
        calls.push({ messages, options })
        yield 'Gern '
        // What the Stop button does: abort the turn's registered controller, with the user's cause.
        inFlightStreams.get(w.convId)!.abort(endedEarlyAbortReason('user'))
        if (options?.signal?.aborted) return
        yield 'geschehen!'
      }
    }
    registerRagIpc(makeRagAskContext(w, runtime).ctx)

    const { result } = await invoke(handlers, IPC.askDocuments, w.convId, MESSAGE, null)

    expect(calls.map(sentAlone)).toEqual([true])
    expect(result as Message).toMatchObject({ content: 'Gern ', endedEarly: 'user' })
    expect(listMessages(w.db, w.convId).map((m) => [m.role, m.content, m.endedEarly])).toEqual([
      ['user', MESSAGE, undefined],
      ['assistant', 'Gern ', 'user']
    ])
    expect(inFlightStreams.has(w.convId)).toBe(false)
  })

  it('a failure before any token leaves the message for "Send again", which answers it with no second copy', async () => {
    const w = await smallTalkChat()
    registerRagIpc(makeRagAskContext(w, failingRuntime()).ctx)
    await expect(invoke(handlers, IPC.askDocuments, w.convId, MESSAGE, null)).rejects.toThrow(/HTTP 400|too large/i)
    const [question] = listMessages(w.db, w.convId)
    expect(listMessages(w.db, w.convId).map((m) => m.role)).toEqual(['user'])

    const calls: ScriptedCall[] = []
    registerRagIpc(makeRagAskContext(w, scriptedRuntime('Gern geschehen!', calls)).ctx)
    const { result } = await invoke(handlers, IPC.askDocuments, w.convId, '', null, false, undefined, question.id)

    expect(calls.map(sentAlone)).toEqual([true])
    expect((result as Message).content).toBe('Gern geschehen!')
    expect(listMessages(w.db, w.convId).map((m) => [m.role, m.id === question.id])).toEqual([
      ['user', true],
      ['assistant', false]
    ])
  })

  it('a regenerate replaces the reply, and a failed one brings the previous reply back', async () => {
    const w = await smallTalkChat()
    appendMessage(w.db, { conversationId: w.convId, role: 'user', content: MESSAGE })
    const prior = appendMessage(w.db, { conversationId: w.convId, role: 'assistant', content: 'Gern geschehen!' })

    registerRagIpc(makeRagAskContext(w, failingRuntime()).ctx)
    await expect(invoke(handlers, IPC.askDocuments, w.convId, '', null, /* regenerate */ true)).rejects.toThrow(/HTTP 400|too large/i)
    expect(listMessages(w.db, w.convId).map((m) => m.id).at(-1)).toBe(prior.id)

    const calls: ScriptedCall[] = []
    registerRagIpc(makeRagAskContext(w, scriptedRuntime('Bitte sehr!', calls)).ctx)
    await invoke(handlers, IPC.askDocuments, w.convId, '', null, /* regenerate */ true)

    expect(calls.map(sentAlone)).toEqual([true])
    expect(listMessages(w.db, w.convId).map((m) => [m.role, m.content])).toEqual([
      ['user', MESSAGE],
      ['assistant', 'Bitte sehr!']
    ])
  })
})
