import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Phase-F filing-suggestions IPC (plan §20). The read-only `docs:filingSuggestions` returns
// the expected set for the unfiled documents; Apply reuses the existing membership channels
// (addToCollection for an existing project; createCollection + addToCollection for a new one);
// the whole path is local SQLite — no network; and the audit log stays content-free (the
// suggestion REASON — a folder label — is never recorded, even though Apply audits ids/counts).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { registerCollectionsIpc } from '../../src/main/ipc/registerCollectionsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createQueuedDocument, processDocument, documentsDir } from '../../src/main/services/ingestion'
import { documentIdsInCollection } from '../../src/main/services/collections'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Collection, FilingSuggestionResult } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

// A folder label is the suggestion REASON (display metadata, never logged). It is a sentinel
// here to prove the audit log never records it via the suggest/apply flow (plan §17).
const FOLDER_SENTINEL = 'XFOLDER_SENTINEL_secret_matter'

function makeCtx(): { ctx: AppContext; db: Db; root: string; storeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-fsipc-'))
  const db = openDatabase(join(root, 'hilbertraum.sqlite'))
  const ctx = {
    db,
    paths: { workspacePath: root },
    embedder: createMockEmbedder(),
    workspace: {
      isUnlocked: () => true,
      beginDocumentWork: () => () => {},
      documentCipher: () => null
    },
    audit: createAuditRecorder(() => db)
  } as unknown as AppContext
  return { ctx, db, root, storeDir: documentsDir(root) }
}

/** Import + index a real (tiny) text document and set its folder label (display metadata). */
async function indexDoc(
  db: Db,
  root: string,
  storeDir: string,
  title: string,
  folderLabel: string | null
): Promise<string> {
  const path = join(root, title)
  writeFileSync(path, 'alpha beta gamma delta epsilon', 'utf8')
  const indexer = createMockEmbedder()
  const { id } = createQueuedDocument(db, path, title)
  await processDocument(db, storeDir, id, { embedder: indexer, embeddingModelId: indexer.id })
  if (folderLabel != null) {
    db.prepare('UPDATE documents SET source_folder_label = ? WHERE id = ?').run(folderLabel, id)
  }
  return id
}

beforeEach(() => ipcState.handlers.clear())

describe('docs:filingSuggestions (plan §20 Phase F)', () => {
  it('returns a folder-name-match suggestion for the unfiled set, and Apply files via addToCollection', async () => {
    const { ctx, db, root, storeDir } = makeCtx()
    registerDocsIpc(ctx)
    registerCollectionsIpc(ctx)

    // A project whose NAME equals the document's source folder label.
    const { result: projRaw } = await invoke(handlers, IPC.createCollection, FOLDER_SENTINEL)
    const proj = projRaw as Collection
    const docId = await indexDoc(db, root, storeDir, 'return.txt', FOLDER_SENTINEL)
    // A second, ordinary unfiled doc with no folder + no pattern → no suggestion.
    const plainId = await indexDoc(db, root, storeDir, 'random-notes.txt', null)

    const { result: sugRaw } = await invoke(handlers, IPC.filingSuggestions)
    const suggestions = sugRaw as FilingSuggestionResult[]
    // Exactly the folder-matching doc is suggested (the plain doc is not).
    expect(suggestions.map((s) => s.documentId)).toEqual([docId])
    expect(suggestions[0].suggestions[0]).toMatchObject({
      ruleId: 'folder-name-match',
      target: { kind: 'existingProject', collectionId: proj.id }
    })
    expect(plainId).toBeTruthy()

    // Apply = the existing membership channel; the doc is now a project member.
    await invoke(handlers, IPC.addToCollection, [docId], proj.id)
    expect(documentIdsInCollection(db, proj.id)).toContain(docId)

    // Re-query: the now-filed doc is no longer suggested (it left the unfiled set).
    const { result: sug2Raw } = await invoke(handlers, IPC.filingSuggestions)
    expect((sug2Raw as FilingSuggestionResult[]).map((s) => s.documentId)).not.toContain(docId)

    // Audit privacy: the suggestion reason (the folder label) is NEVER recorded; Apply
    // records only ids/counts (documents_added_to_collection).
    const recorded = listAuditEvents(db, { limit: 5000 })
      .map((e) => `${e.type} ${e.message} ${JSON.stringify(e.metadata)}`)
      .join('\n')
    expect(recorded).not.toContain(FOLDER_SENTINEL)
    expect(recorded).toContain('documents_added_to_collection')
  })

  it('a filename-pattern suggestion with no matching project proposes a NEW project; Apply creates + files it', async () => {
    const { ctx, db, root, storeDir } = makeCtx()
    registerDocsIpc(ctx)
    registerCollectionsIpc(ctx)

    const docId = await indexDoc(db, root, storeDir, 'ACME-invoice-0042.txt', null)

    const { result: sugRaw } = await invoke(handlers, IPC.filingSuggestions)
    const suggestions = sugRaw as FilingSuggestionResult[]
    const top = suggestions.find((s) => s.documentId === docId)?.suggestions[0]
    expect(top).toMatchObject({
      ruleId: 'filename-pattern',
      target: { kind: 'newProject', suggestedName: 'Invoices' }
    })

    // Apply (new project) = createCollection then addToCollection.
    const { result: createdRaw } = await invoke(handlers, IPC.createCollection, 'Invoices')
    const created = createdRaw as Collection
    await invoke(handlers, IPC.addToCollection, [docId], created.id)
    expect(documentIdsInCollection(db, created.id)).toEqual([docId])
  })
})
