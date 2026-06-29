import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { appendMessage, createConversation, listMessages } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { AppContext } from '../../src/main/services/context'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** Seed one indexed document with a single chunk + its mock embedding, so retrieval finds
 *  context for `text` and the grounded path reaches the model. */
async function seedDocument(db: Db, embedder: MockEmbedder, title: string, text: string): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const [vector] = await embedder.embed([text])
  const chunkId = randomUUID()
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
     VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?)`
  ).run(chunkId, docId, text, title, text.split(/\s+/).length, now)
  db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(chunkId, embedder.id, encodeVector(vector), vector.length, now)
  return docId
}

/** A runtime whose grounded generation fails with a NON-abort error before any token — the
 *  context-exceeded 400 that regenerate (a full-history replay near the window) most reaches. */
function throwingRuntime(): ModelRuntime {
  return {
    modelId: 'throwing',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    // eslint-disable-next-line require-yield
    async *chatStream(_messages: ChatMessage[]): AsyncGenerator<string> {
      throw new Error('Chat request failed: HTTP 400 exceed_context_size_error')
    }
  }
}

function freshDb(): { db: Db; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-ragregen-'))
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return { db, workspacePath: join(root, 'workspace') }
}

function makeCtx(db: Db, workspacePath: string, runtime: ModelRuntime): AppContext {
  return {
    paths: { rootPath: workspacePath, workspacePath },
    get db() {
      return db
    },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId },
    embedder: createMockEmbedder(),
    reranker: null,
    ocrEngine: undefined
  } as unknown as AppContext
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('askDocuments regenerate — F2 data-loss guard', () => {
  it('a regenerate whose grounded generation fails restores the prior assistant reply', async () => {
    const { db, workspacePath } = freshDb()
    const embedder = new MockEmbedder()
    const question = 'what are the payment terms'
    const docId = await seedDocument(db, embedder, 'contract.pdf', question)
    const conv = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [docId] }
    })
    // The prior document turn: the user question + the assistant answer that regenerate re-runs.
    appendMessage(db, { conversationId: conv.id, role: 'user', content: question })
    const prior = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'the original grounded answer'
    })

    registerRagIpc(makeCtx(db, workspacePath, throwingRuntime()))

    await expect(
      invoke(handlers, IPC.askDocuments, conv.id, question, null, /* regenerate */ true)
    ).rejects.toThrow(/HTTP 400|too large/i)

    // The prior answer survives — the conversation is not left answer-less; restored byte-faithfully.
    const history = listMessages(db, conv.id)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(history.at(-1)?.content).toBe('the original grounded answer')
    expect(history.at(-1)?.id).toBe(prior.id)
    expect(inFlightStreams.has(conv.id)).toBe(false)
  })
})
