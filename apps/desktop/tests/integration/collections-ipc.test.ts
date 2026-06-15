import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Document-organization Phase B: the collections / membership / lifecycle / scope IPC
// surface and the resolveScope-in-IPC wiring (filename auto-scope WITHIN the resolved
// scope, skipped on a deliberate hand-pick — N2). CI stays zero-network / zero-model
// (echo runtime + mock embedder behind the IngestionDeps seam).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {},
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { registerCollectionsIpc } from '../../src/main/ipc/registerCollectionsIpc'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { documentsDir } from '../../src/main/services/ingestion'
import { IPC, STREAM } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { getBuiltinCollection, resolveScope } from '../../src/main/services/collections'
import { seedSettings } from '../../src/main/services/settings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { ModelRuntime, ChatMessage } from '../../src/main/services/runtime'
import type { AppContext } from '../../src/main/services/context'
import type { Collection, Conversation, DocumentInfo, ImportJob, ImportJobStatus } from '../../src/shared/types'
import { invoke, invokeWithEvent, makeEvent, type IpcHandlers } from '../helpers/ipc'
import { inFlightStreams } from '../../src/main/ipc/inflight'

const handlers = ipcState.handlers as unknown as IpcHandlers

function echoRuntime(): ModelRuntime {
  return {
    modelId: 'echo',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    async *chatStream(messages: ChatMessage[]) {
      yield `echo: ${messages[messages.length - 1]?.content ?? ''}`
    }
  }
}

interface Harness {
  ctx: AppContext
  db: Db
  rootPath: string
}

function makeHarness(): Harness {
  const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-collipc-'))
  const workspacePath = join(rootPath, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const db = openDatabase(join(workspacePath, 'test.sqlite'))
  seedSettings(db)
  const runtime = echoRuntime()
  const ctx = {
    paths: { rootPath, workspacePath },
    db,
    workspace: {
      isUnlocked: () => true,
      documentCipher: () => null,
      beginDocumentWork: () => () => {}
    },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId },
    embedder: createMockEmbedder(),
    reranker: null,
    docTasks: {
      isDocumentBusy: () => false,
      hasActiveTask: () => false,
      isYieldingBuildActive: () => false,
      acquireChatSlot: async () => () => {}
    },
    audit: () => {}
  } as unknown as AppContext
  return { ctx, db, rootPath }
}

/** STREAM.scope titles the rag handler streamed via `event.sender.send`, if any. */
function scopeTitles(event: ReturnType<typeof makeEvent>): string[] {
  for (const call of event.sender.send.mock.calls) {
    const [channel, payload] = call as [string, { titles?: string[] }]
    if (channel.startsWith('chat:scope:')) return payload.titles ?? []
  }
  return []
}

async function importIndexed(ctx: AppContext, filePath: string): Promise<string> {
  const { result } = await invoke(handlers, IPC.importDocuments, [filePath])
  const job = result as ImportJob
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { result: s } = await invoke(handlers, IPC.getImportJob, job.jobId)
    if ((s as ImportJobStatus).done) break
    if (Date.now() - start > 5000) throw new Error('import timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
  return job.documentIds[0]
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('collections IPC — CRUD', () => {
  it('creates, lists, renames, archives, and deletes a project (built-ins are seeded)', async () => {
    const h = makeHarness()
    registerCollectionsIpc(h.ctx)

    const { result: list0 } = await invoke(handlers, IPC.listCollections)
    expect((list0 as Collection[]).map((c) => c.type).sort()).toEqual(['library', 'temporary'])

    const { result: createdRaw } = await invoke(handlers, IPC.createCollection, 'Tax 2025')
    const created = createdRaw as Collection
    expect(created).toMatchObject({ name: 'Tax 2025', type: 'project', builtin: false })

    const { result: renamed } = await invoke(handlers, IPC.renameCollection, created.id, 'Tax 2026')
    expect((renamed as Collection).name).toBe('Tax 2026')

    const { result: archived } = await invoke(handlers, IPC.setCollectionArchived, created.id, true)
    expect((archived as Collection).archivedAt).not.toBeNull()

    await invoke(handlers, IPC.deleteCollection, created.id, 'membershipOnly')
    const { result: list1 } = await invoke(handlers, IPC.listCollections)
    expect((list1 as Collection[]).some((c) => c.id === created.id)).toBe(false)
  })

  it('refuses to delete a built-in collection', async () => {
    const h = makeHarness()
    registerCollectionsIpc(h.ctx)
    const library = getBuiltinCollection(h.db, 'library')!
    await expect(invoke(handlers, IPC.deleteCollection, library.id, 'membershipOnly')).rejects.toThrow()
  })
})

describe('docs membership + lifecycle IPC', () => {
  it('adds/removes membership and flips lifecycle; listDocuments reflects both', async () => {
    const h = makeHarness()
    registerDocsIpc(h.ctx)
    registerCollectionsIpc(h.ctx)
    const docPath = join(h.rootPath, 'note.txt')
    writeFileSync(docPath, 'the quarterly figures are strong\n', 'utf8')
    const docId = await importIndexed(h.ctx, docPath)

    // Import default-files into Library (plan §11.2).
    const { result: docsA } = await invoke(handlers, IPC.listDocuments)
    const a = (docsA as DocumentInfo[]).find((d) => d.id === docId)!
    expect(a.collections?.some((c) => c.type === 'library')).toBe(true)
    expect(a.lifecycle).toBe('permanent')

    const { result: projRaw } = await invoke(handlers, IPC.createCollection, 'Project X')
    const proj = projRaw as Collection
    await invoke(handlers, IPC.addToCollection, [docId], proj.id)
    await invoke(handlers, IPC.setDocumentLifecycle, [docId], 'temporary')

    const { result: docsB } = await invoke(handlers, IPC.listDocuments)
    const b = (docsB as DocumentInfo[]).find((d) => d.id === docId)!
    expect(b.collections?.some((c) => c.id === proj.id)).toBe(true)
    expect(b.lifecycle).toBe('temporary')

    // A collection-filtered listing returns only that project's members.
    const { result: scoped } = await invoke(handlers, IPC.listDocuments, { collectionId: proj.id })
    expect((scoped as DocumentInfo[]).map((d) => d.id)).toEqual([docId])

    await invoke(handlers, IPC.removeFromCollection, [docId], proj.id)
    const { result: docsC } = await invoke(handlers, IPC.listDocuments)
    expect((docsC as DocumentInfo[]).find((d) => d.id === docId)!.collections?.some((c) => c.id === proj.id)).toBe(false)
  })

  it('delete-project "withDocuments" never deletes a Library member (C2)', async () => {
    const h = makeHarness()
    registerDocsIpc(h.ctx)
    registerCollectionsIpc(h.ctx)
    const library = getBuiltinCollection(h.db, 'library')!
    const { result: projRaw } = await invoke(handlers, IPC.createCollection, 'Lawsuit')
    const proj = projRaw as Collection

    // A: in Library AND the project (Library knowledge — must survive).
    const aPath = join(h.rootPath, 'library-doc.txt')
    writeFileSync(aPath, 'company policy\n', 'utf8')
    const aId = await importIndexed(h.ctx, aPath) // files into Library
    await invoke(handlers, IPC.addToCollection, [aId], proj.id)
    // B: project-only (imported into Library by default, then dropped from Library).
    const bPath = join(h.rootPath, 'project-only.txt')
    writeFileSync(bPath, 'case-specific note\n', 'utf8')
    const bId = await importIndexed(h.ctx, bPath)
    await invoke(handlers, IPC.addToCollection, [bId], proj.id)
    await invoke(handlers, IPC.removeFromCollection, [bId], library.id)

    await invoke(handlers, IPC.deleteCollection, proj.id, 'withDocuments')

    const { result: docs } = await invoke(handlers, IPC.listDocuments)
    const ids = (docs as DocumentInfo[]).map((d) => d.id)
    expect(ids).toContain(aId) // the Library member is spared
    expect(ids).not.toContain(bId) // the genuinely project-only doc is deleted
  })
})

describe('chat:setScope persistence', () => {
  it('round-trips a composite DocumentScope and survives a DB reopen', async () => {
    const h = makeHarness()
    registerChatIpc(h.ctx)
    const library = getBuiltinCollection(h.db, 'library')!
    const { result: convRaw } = await invoke(handlers, IPC.createConversation, { mode: 'documents' })
    const conv = convRaw as Conversation
    const scope = { collectionIds: [library.id], documentIds: ['contractA'] }
    await invoke(handlers, IPC.setConversationScope, conv.id, scope)

    // Reopen the DB file (simulating an app restart) and resolve the stored scope.
    const dbPath = join(h.rootPath, 'workspace', 'test.sqlite')
    h.db.close()
    const reopened = openDatabase(dbPath)
    const resolved = resolveScope(reopened, conv.id)
    expect(resolved.collectionIds).toEqual([library.id])
    expect(resolved.documentIds).toEqual(['contractA'])
    expect(resolved.hasExplicitDocSelection).toBe(true)
  })
})

describe('resolveScope-in-IPC: filename auto-scope within the resolved scope', () => {
  it('narrows to a named file within scope, and skips on a deliberate hand-pick (N2)', async () => {
    const h = makeHarness()
    registerDocsIpc(h.ctx)
    registerChatIpc(h.ctx)
    registerCollectionsIpc(h.ctx)
    registerRagIpc(h.ctx)
    void documentsDir(h.ctx.paths.workspacePath)

    const aPath = join(h.rootPath, 'contractA.txt')
    writeFileSync(aPath, 'the contract sets the delivery date to June\n', 'utf8')
    const aId = await importIndexed(h.ctx, aPath)
    const bPath = join(h.rootPath, 'manual.txt')
    writeFileSync(bPath, 'the manual explains the setup steps\n', 'utf8')
    await importIndexed(h.ctx, bPath)

    // Default (Library) scope, no hand-pick: a question naming contractA narrows to it,
    // emitting the STREAM.scope notice with that filename.
    const { result: convRaw } = await invoke(handlers, IPC.createConversation, { mode: 'documents' })
    const conv = convRaw as Conversation
    const e1 = makeEvent()
    await invokeWithEvent(handlers, IPC.askDocuments, e1, conv.id, 'what does contractA say?')
    expect(scopeTitles(e1)).toContain('contractA.txt')

    // A deliberate hand-pick (scope.documentIds) skips filename auto-scope (N2): no notice.
    const { result: conv2Raw } = await invoke(handlers, IPC.createConversation, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [aId] }
    })
    const conv2 = conv2Raw as Conversation
    const e2 = makeEvent()
    await invokeWithEvent(handlers, IPC.askDocuments, e2, conv2.id, 'what does contractA say?')
    expect(scopeTitles(e2)).toHaveLength(0)
  })
})

// Sanity: the STREAM channel shape the scope sink parses matches the real factory.
it('STREAM.scope channel shape matches the sink parser', () => {
  expect(STREAM.scope('abc')).toBe('chat:scope:abc')
})
