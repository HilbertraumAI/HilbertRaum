import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Phase 33 IPC-layer tests: the doctasks:start/get/cancel handlers, the D26 guard in
// the chat + RAG handlers (friendly busy copy, shared constant), the inverse guard
// (doc task refuses while a chat streams), and the busy-document re-index/delete guard.
// Real handler glue, faked transport (the helpers/ipc harness).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}))

import { IPC } from '../../src/shared/ipc'
import { DOC_TASK_BUSY_MESSAGE, type Conversation, type DocTaskStatus } from '../../src/shared/types'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, getSettings } from '../../src/main/services/settings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import {
  createQueuedDocument,
  documentsDir,
  processDocument
} from '../../src/main/services/ingestion'
import { DocTaskManager } from '../../src/main/services/doctasks'
import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { registerDocTasksIpc } from '../../src/main/ipc/registerDocTasksIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { AppContext } from '../../src/main/services/context'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

interface Harness {
  ctx: AppContext
  db: Db
  docId: string
  runtime: ModelRuntime
  releaseGate: () => void
}

/** Real DB + one indexed document + a gateable runtime, wired through the real handlers. */
async function makeHarness(opts: { unlocked?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'paid-dtipc-'))
  const workspacePath = join(root, 'workspace')
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)

  const storeDir = documentsDir(workspacePath)
  const docPath = join(root, 'notes.txt')
  writeFileSync(docPath, Array.from({ length: 80 }, (_, i) => `note${i}`).join(' '), 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, { embedder: createMockEmbedder() })

  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const runtime: ModelRuntime = {
    modelId: 'gated-model',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
      await gate
      if (options?.signal?.aborted) return
      yield 'A short summary.'
    }
  }

  const unlocked = opts.unlocked ?? true
  const ctx = {
    paths: { rootPath: root, workspacePath },
    get db() {
      return db
    },
    workspace: {
      isUnlocked: () => unlocked,
      documentCipher: () => null,
      beginDocumentWork: () => () => {}
    },
    runtime: {
      active: () => runtime,
      activeModelId: () => runtime.modelId
    },
    embedder: createMockEmbedder(),
    manifestsDir: null,
    isDev: true
  } as unknown as AppContext
  ctx.docTasks = new DocTaskManager({
    getDb: () => ctx.db,
    getRuntime: () => ctx.runtime.active(),
    isChatStreaming: () => inFlightStreams.size > 0,
    getContextTokens: () => getSettings(ctx.db).contextTokens
  })

  registerChatIpc(ctx)
  registerRagIpc(ctx)
  registerDocsIpc(ctx)
  registerDocTasksIpc(ctx)
  return { ctx, db, docId: doc.id, runtime, releaseGate: release }
}

async function pollTerminal(jobId: string): Promise<DocTaskStatus> {
  const start = Date.now()
  for (;;) {
    const { result } = await invoke(handlers, IPC.getDocTask, jobId)
    const status = result as DocTaskStatus
    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {
      return status
    }
    if (Date.now() - start > 5000) throw new Error('task never finished')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('doctasks IPC (start / get / cancel)', () => {
  it('runs a summary end-to-end over the polling contract', async () => {
    const h = await makeHarness()
    const { result } = await invoke(handlers, IPC.startDocTask, {
      kind: 'summary',
      documentIds: [h.docId]
    })
    const { jobId } = result as { jobId: string }
    expect(jobId).toBeTruthy()
    h.releaseGate()
    const status = await pollTerminal(jobId)
    expect(status.state).toBe('done')
    expect(status.resultRef).toEqual({ documentId: h.docId })
  })

  it('cancel without a jobId cancels the active task (the chat banner affordance)', async () => {
    const h = await makeHarness()
    const { result } = await invoke(handlers, IPC.startDocTask, {
      kind: 'summary',
      documentIds: [h.docId]
    })
    const { jobId } = result as { jobId: string }
    await invoke(handlers, IPC.cancelDocTask)
    h.releaseGate()
    expect((await pollTerminal(jobId)).state).toBe('cancelled')
  })

  it('refuses to start while the workspace is locked', async () => {
    const h = await makeHarness({ unlocked: false })
    await expect(
      invoke(handlers, IPC.startDocTask, { kind: 'summary', documentIds: [h.docId] })
    ).rejects.toThrow(/locked/i)
    h.releaseGate()
  })
})

describe('strict one-at-a-time vs chat (D26)', () => {
  it('chat:send during an active task gets the shared friendly busy copy', async () => {
    const h = await makeHarness()
    const { result: convRaw } = await invoke(handlers, IPC.createConversation, {})
    const conv = convRaw as Conversation

    const { result } = await invoke(handlers, IPC.startDocTask, {
      kind: 'summary',
      documentIds: [h.docId]
    })
    await expect(
      invoke(handlers, IPC.sendChatMessage, conv.id, 'hello while busy')
    ).rejects.toThrow(DOC_TASK_BUSY_MESSAGE)
    // The refused message was NOT persisted as a user turn.
    const { result: messages } = await invoke(handlers, IPC.listMessages, conv.id)
    expect(messages).toEqual([])

    h.releaseGate()
    await pollTerminal((result as { jobId: string }).jobId)
  })

  it('rag:ask during an active task gets the same copy', async () => {
    const h = await makeHarness()
    const { result: convRaw } = await invoke(handlers, IPC.createConversation, {
      mode: 'documents'
    })
    const conv = convRaw as Conversation
    const { result } = await invoke(handlers, IPC.startDocTask, {
      kind: 'summary',
      documentIds: [h.docId]
    })
    await expect(
      invoke(handlers, IPC.askDocuments, conv.id, 'what do my notes say?')
    ).rejects.toThrow(DOC_TASK_BUSY_MESSAGE)
    h.releaseGate()
    await pollTerminal((result as { jobId: string }).jobId)
  })

  it('a task refuses to start while a chat answer is streaming (the inverse guard)', async () => {
    const h = await makeHarness()
    inFlightStreams.set('some-conversation', new AbortController())
    await expect(
      invoke(handlers, IPC.startDocTask, { kind: 'summary', documentIds: [h.docId] })
    ).rejects.toThrow(/answer is being written/i)
    inFlightStreams.clear()
    h.releaseGate()
  })
})

describe('busy-document guard (re-index / delete during a task)', () => {
  it('refuses re-index and delete of the document a task is working on', async () => {
    const h = await makeHarness()
    const { result } = await invoke(handlers, IPC.startDocTask, {
      kind: 'summary',
      documentIds: [h.docId]
    })
    await expect(invoke(handlers, IPC.reindexDocument, h.docId)).rejects.toThrow(
      /task is running for this document/i
    )
    await expect(invoke(handlers, IPC.deleteDocument, h.docId)).rejects.toThrow(
      /task is running for this document/i
    )
    h.releaseGate()
    await pollTerminal((result as { jobId: string }).jobId)
    // After the task finished both operations work again.
    await expect(invoke(handlers, IPC.reindexDocument, h.docId)).resolves.toBeTruthy()
  })
})
