import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

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
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { appendMessage, createConversation, listMessages } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { AppContext } from '../../src/main/services/context'
import { createPendingModelSwitchCounter } from '../../src/main/services/rag/device-posture'
import type { ModelRuntime } from '../../src/main/services/runtime'
import { tempRoot } from '../helpers/db-fixtures'
import { seedEmbeddedDoc } from '../helpers/doc-fixtures'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { failingRuntime, scriptedRuntime, type ScriptedCall } from '../helpers/scripted-runtime'
import { t } from '../../src/shared/i18n'
import type { Message } from '../../src/shared/types'

const handlers = ipcState.handlers as unknown as IpcHandlers

function freshDb(): { db: Db; workspacePath: string } {
  const root = tempRoot('ragregen')
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return { db, workspacePath: join(root, 'workspace') }
}

function makeCtx(db: Db, workspacePath: string, runtime: ModelRuntime): AppContext {
  return {
    trustedSenders: ANY_SENDER,
    paths: { rootPath: workspacePath, workspacePath },
    get db() {
      return db
    },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId },
    embedder: createMockEmbedder(),
    reranker: null,
    ocrEngine: undefined,
    // #477: pendingModelSwitches is required — the ask path's occupancy snapshot reads it
    // unconditionally now (no more `??` fallback).
    pendingModelSwitches: createPendingModelSwitchCounter()
  } as unknown as AppContext
}

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
    const { db, workspacePath } = freshDb()
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

    registerRagIpc(makeCtx(db, workspacePath, failingRuntime()))
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
  async function unansweredDocumentQuestion(): Promise<{ db: Db; workspacePath: string; convId: string; questionId: string }> {
    const { db, workspacePath } = freshDb()
    const question = 'what are the payment terms'
    const docId = await seedEmbeddedDoc(db, new MockEmbedder(), 'contract.pdf', [question])
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    const q = appendMessage(db, { conversationId: conv.id, role: 'user', content: question })
    return { db, workspacePath, convId: conv.id, questionId: q.id }
  }

  it('answers the unanswered last question from the documents — no second copy', async () => {
    const { db, workspacePath, convId, questionId } = await unansweredDocumentQuestion()
    const calls: ScriptedCall[] = []
    registerRagIpc(makeCtx(db, workspacePath, scriptedRuntime('Net 30 days.', calls)))

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
    const { db, workspacePath, convId, questionId } = await unansweredDocumentQuestion()
    appendMessage(db, { conversationId: convId, role: 'assistant', content: 'answered meanwhile' })
    const calls: ScriptedCall[] = []
    registerRagIpc(makeCtx(db, workspacePath, scriptedRuntime('never', calls)))
    const before = listMessages(db, convId)

    await expect(
      invoke(handlers, IPC.askDocuments, convId, '', null, false, undefined, questionId)
    ).rejects.toThrow(t('en', 'main.chat.nothingToResend'))

    expect(calls).toHaveLength(0)
    expect(listMessages(db, convId)).toEqual(before)
  })
})
