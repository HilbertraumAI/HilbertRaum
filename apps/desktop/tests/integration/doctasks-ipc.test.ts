import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Phase 33 IPC-layer tests: the doctasks:start/get/cancel glue (the cancel routing), the D26 guard
// in the chat + RAG handlers (shared friendly busy copy, nothing persisted), and the busy-document
// re-index/delete guard over a REAL DocTaskManager (with the preview negative control). The service guards live
// in doctasks.test.ts / doctasks-compare.test.ts; the locked-vault refusal is ipc-lock-coverage's MODULES row.

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
import {
  DOC_TASK_BUSY_MESSAGE,
  type Conversation,
  type DocTaskStatus,
  type DocumentPreview
} from '../../src/shared/types'
import type { Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { registerDocTasksIpc } from '../../src/main/ipc/registerDocTasksIpc'
import { inFlightStreams, isChatStreaming } from '../../src/main/ipc/inflight'
import { TASK_REFUSED_CHAT_STREAMING_MESSAGE } from '../../src/main/services/doctasks'
import type { AppContext } from '../../src/main/services/context'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { hangBudgetMs, until } from '../helpers/hang-budget'
import {
  docTaskManager,
  docTaskRuntime,
  docTaskWorld,
  importWords,
  type DocRuntime
} from '../helpers/doctask-fixtures'

const handlers = ipcState.handlers as unknown as IpcHandlers

interface Harness {
  ctx: AppContext
  db: Db
  docId: string
  docIdB: string
  runtime: DocRuntime
  releaseGate: () => void
}

/** Real DB + two indexed documents + a gateable runtime, wired through the real handlers. */
async function makeHarness(): Promise<Harness> {
  const w = docTaskWorld('dtipc')
  seedSettings(w.db) // registerChatIpc's conversation handlers read the settings row
  const embedder = createMockEmbedder()
  const docId = await importWords(w, 80, { name: 'notes.txt', prefix: 'note', deps: { embedder } })
  const docIdB = await importWords(w, 80, { name: 'notes-v2.txt', prefix: 'memo', deps: { embedder } })

  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const runtime = docTaskRuntime({ gate: () => gate })

  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath: w.root, workspacePath: join(w.root, 'workspace') },
    db: w.db,
    workspace: {
      isUnlocked: () => true,
      documentCipher: () => null,
      beginDocumentWork: () => () => {}
    },
    runtime: {
      active: () => runtime,
      activeModelId: () => runtime.modelId
    },
    embedder,
    manifestsDir: null,
    isDev: true
  } as unknown as AppContext
  // `isChatStreaming` is the production predicate `main/index.ts` passes (#682), never a harness copy.
  ctx.docTasks = docTaskManager(w, { getRuntime: () => runtime, getIngestionDeps: () => ({ embedder }), isChatStreaming })

  registerChatIpc(ctx)
  registerRagIpc(ctx)
  registerDocsIpc(ctx)
  registerDocTasksIpc(ctx)
  return { ctx, db: w.db, docId, docIdB, runtime, releaseGate: release }
}

async function pollTerminal(jobId: string): Promise<DocTaskStatus> {
  const start = Date.now()
  for (;;) {
    const { result } = await invoke(handlers, IPC.getDocTask, jobId)
    const status = result as DocTaskStatus
    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {
      return status
    }
    if (Date.now() - start > hangBudgetMs(5000)) throw new Error('task never finished')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('doctasks IPC (start / get / cancel)', () => {
  // The no-id forms: no argument is the wire shape of `window.api.cancelDocTask()` (the preload forwards
  // `undefined`, the chat banner's cancel); '' is the handler's other "no id".
  it.each([
    { noId: 'no argument', args: [] as string[] },
    { noId: 'an empty id', args: [''] }
  ])('cancel routes a present jobId to that exact task (queued too) and $noId to the active task (#157 DT-2)', async ({ args }) => {
    const h = await makeHarness()
    const start = async (documentId: string): Promise<string> =>
      ((await invoke(handlers, IPC.startDocTask, { kind: 'summary', documentIds: [documentId] })).result as {
        jobId: string
      }).jobId
    const stateOf = async (jobId: string): Promise<DocTaskStatus['state']> =>
      ((await invoke(handlers, IPC.getDocTask, jobId)).result as DocTaskStatus).state
    const a = await start(h.docId) // running, parked on the gate
    const b = await start(h.docIdB) // queued behind it
    expect(await stateOf(a)).toBe('running')
    expect(await stateOf(b)).toBe('queued')
    await invoke(handlers, IPC.cancelDocTask, b) // a present id: exactly that task, queued or not
    expect(await stateOf(b)).toBe('cancelled')
    expect(await stateOf(a)).toBe('running') // never "the active task"
    await invoke(handlers, IPC.cancelDocTask, ...args) // no id: the active task
    h.releaseGate()
    expect((await pollTerminal(a)).state).toBe('cancelled')
  })
})

describe('strict one-at-a-time vs chat (D26)', () => {
  it.each([
    { channel: IPC.sendChatMessage, mode: 'chat' as const, text: 'hello while busy' },
    { channel: IPC.askDocuments, mode: 'documents' as const, text: 'what do my notes say?' }
  ])(
    '$channel during an active task gets the shared friendly busy copy and persists no user turn',
    async ({ channel, mode, text }) => {
      const h = await makeHarness()
      const conv = (await invoke(handlers, IPC.createConversation, { mode })).result as Conversation
      const { jobId } = (await invoke(handlers, IPC.startDocTask, { kind: 'summary', documentIds: [h.docId] }))
        .result as { jobId: string }
      await expect(invoke(handlers, channel, conv.id, text)).rejects.toThrow(DOC_TASK_BUSY_MESSAGE)
      // The refused message was NOT persisted as a user turn.
      expect((await invoke(handlers, IPC.listMessages, conv.id)).result).toEqual([])
      h.releaseGate()
      await pollTerminal(jobId)
    }
  )

  // The inverse guard over the real wiring (#682): a chat answer streaming through `chat:send` registers in the
  // stream registry the shared predicate reads, so a task is refused until the answer ends, then admitted.
  it('a task refuses to start while a chat answer streams and starts once it has ended', async () => {
    const h = await makeHarness()
    const conv = (await invoke(handlers, IPC.createConversation, { mode: 'chat' })).result as Conversation
    const answer = invoke(handlers, IPC.sendChatMessage, conv.id, 'hello') // parked on the runtime gate
    // Wait on the chat lane's own registry, so a broken predicate fails the refusal below, not this wait.
    await until(() => inFlightStreams.size > 0, 'the chat answer registering its stream')
    await expect(invoke(handlers, IPC.startDocTask, { kind: 'summary', documentIds: [h.docId] })).rejects.toThrow(
      TASK_REFUSED_CHAT_STREAMING_MESSAGE
    )
    h.releaseGate()
    await answer
    expect(inFlightStreams.size).toBe(0)
    const { jobId } = (await invoke(handlers, IPC.startDocTask, { kind: 'summary', documentIds: [h.docId] }))
      .result as { jobId: string }
    expect((await pollTerminal(jobId)).state).toBe('done')
  })
})

describe('busy-document guard (re-index / delete during a task)', () => {
  it.each([
    { kind: 'summary' as const, sources: (h: Harness) => [h.docId], newDocument: false },
    { kind: 'compare' as const, sources: (h: Harness) => [h.docId, h.docIdB], newDocument: true }
  ])(
    'a running $kind task blocks re-index, delete and original export of every source, never preview, and ends done over the polling contract',
    async ({ kind, sources, newDocument }) => {
      const h = await makeHarness()
      const ids = sources(h)
      const { jobId } = (await invoke(handlers, IPC.startDocTask, { kind, documentIds: ids })).result as {
        jobId: string
      }
      for (const id of ids) {
        await expect(invoke(handlers, IPC.reindexDocument, id)).rejects.toThrow(/task is running for this document/i)
        await expect(invoke(handlers, IPC.deleteDocument, id)).rejects.toThrow(/task is running for this document/i)
        // #682: the original export takes the same task gate (it reads the stored copy a re-index rewrites).
        await expect(invoke(handlers, IPC.exportDocumentOriginal, id)).rejects.toThrow(/task is running for this document/i)
        // Negative control (was docs-ipc T-3): preview only reads the stored copy, so it consults the processing
        // gate, never the task gate — it still resolves with content while the task runs.
        const preview = (await invoke(handlers, IPC.previewDocument, id)).result as DocumentPreview
        expect(preview.segments.length).toBeGreaterThan(0)
      }
      h.releaseGate()
      const status = await pollTerminal(jobId)
      expect(status.state).toBe('done')
      const resultId = status.resultRef?.documentId
      // A summary is stored on its source; a compare materializes a NEW report document.
      if (newDocument) {
        expect(resultId).toBeTruthy()
        expect(ids).not.toContain(resultId)
      } else {
        expect(status.resultRef).toEqual({ documentId: h.docId })
      }
      // After the task finished the operations work again.
      for (const id of ids) {
        await expect(invoke(handlers, IPC.reindexDocument, id)).resolves.toBeTruthy()
        // The save dialog is cancelled in this file's electron mock: an admitted export resolves null.
        expect((await invoke(handlers, IPC.exportDocumentOriginal, id)).result).toBeNull()
      }
    }
  )
})

// #682: `main/index.ts` is composition with no unit harness, so its one-word pass of the shared predicate is pinned by
// source text (precedent: the #410 pin in compose-ocr.test.ts); the inverse-guard row above runs on that same predicate.
describe('#682 wiring pin: main/index.ts hands the doc-task manager the shared chat predicate', () => {
  it('the DocTaskManager deps pass isChatStreaming from ipc/inflight, not a local copy', () => {
    const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    const start = src.indexOf('new DocTaskManager({')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = src.slice(start, src.indexOf('\n  })\n', start))
    expect(src).toMatch(/import \{[^}]*\bisChatStreaming\b[^}]*\} from '\.\/ipc\/inflight'/)
    expect(block).toMatch(/^\s*isChatStreaming,$/m)
  })
})
