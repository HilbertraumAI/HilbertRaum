import { describe, it, expect, beforeEach, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// Knowledge packs (ZIM wave): the packs:* IPC surface — dialog-in-handler registration
// (no renderer-supplied paths), list-with-discovery, remove/enable, the ids-only audit
// rule, and the scope round-trip (packIds persist through setScope → resolveScope).

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  dialogPaths: [] as string[],
  dialogCancel: false
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: ipcState.dialogCancel, filePaths: ipcState.dialogPaths })
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerZimIpc } from '../../src/main/ipc/registerZimIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createConversation, setScope } from '../../src/main/services/chat'
import { resolveScope } from '../../src/main/services/collections'
import { retrievablePacks, type PackDeps } from '../../src/main/services/zim/packs'
import * as packs from '../../src/main/services/zim/packs'
import type { AppContext } from '../../src/main/services/context'
import type { KnowledgePack } from '../../src/shared/types'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

// The pack whose name/title must NEVER reach the audit log (the collections PROJECT_SENTINEL rule).
const TITLE_SENTINEL = 'XPACKTITLE_SENTINEL_meine-krankheit'
const FILE_SENTINEL = 'XPACKFILE_SENTINEL_wikipedia_med'

interface Harness {
  ctx: AppContext
  db: Db
  zimDir: string
  auditCalls: Array<{ type: string; message: string; metadata: unknown }>
}

/** A ZimService stand-in over the REAL packs registry with a fake kiwix-manage. */
function fakeZimService(db: () => Db, zimDir: string): unknown {
  const deps: PackDeps = {
    zimDir,
    manageAdd: async (libraryXmlPath, zimPath) => {
      const leaf = basename(zimPath)
      if (leaf.includes('corrupt')) throw new Error(`Cannot add ZIM ${zimPath} to the library.`)
      appendFileSync(
        libraryXmlPath,
        `<book id="uuid-${Buffer.from(leaf).toString('hex').slice(0, 16)}" path="${zimPath.replace(/\\/g, '/')}" ` +
          `title="${TITLE_SENTINEL} ${leaf}" language="deu" date="2026-07-01" articleCount="42" />\n`
      )
    }
  }
  return {
    toolsInstalled: () => true,
    listPacks: (d: Db) => packs.listPacks(d, zimDir),
    discoverDrivePacks: (d: Db) => packs.discoverDrivePacks(d, deps),
    registerPack: (d: Db, p: string) => packs.registerPack(d, deps, p),
    removePack: (d: Db, id: string) => packs.removePack(d, id),
    setPackEnabled: (d: Db, id: string, enabled: boolean) => packs.setPackEnabled(d, id, enabled),
    getArticle: async () => null,
    makeArm: () => null,
    // #301 P3b: `packs:add` opens the native picker under a service-owned operation. This
    // stand-in has no operation registry, so it returns the always-admitted no-op shape the
    // real service also uses when `ctx.zimOps` is absent. The SESSION behaviour (a lock
    // aborting a parked picker, the late result refused) is driven against the REAL service in
    // zim-ipc-session.test.ts, not here.
    beginRegistration: () => ({
      signal: new AbortController().signal,
      epoch: null,
      assert: () => undefined,
      track: () => undefined,
      release: () => undefined
    }),
    suspend: async () => {},
    cleanupTransients: () => ({
      removed: 0,
      kept: 0,
      unknownEntries: 0,
      unsettledOps: 0,
      unconfirmedChildren: 0,
      confirmed: true
    }),
    whenSettled: async () => {},
    stop: async () => {}
  }
}

function makeHarness(): Harness {
  ipcState.handlers.clear()
  ipcState.dialogPaths = []
  ipcState.dialogCancel = false
  const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-zimipc-'))
  const workspacePath = join(rootPath, 'workspace')
  const zimDir = join(rootPath, 'zim')
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(zimDir, { recursive: true })
  const db = openDatabase(join(workspacePath, 'test.sqlite'))
  seedSettings(db)
  const auditCalls: Harness['auditCalls'] = []
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath, workspacePath },
    db,
    workspace: { isUnlocked: () => true },
    audit: (type: string, message: string, metadata: unknown) =>
      auditCalls.push({ type, message, metadata }),
    zim: fakeZimService(() => db, zimDir)
  } as unknown as AppContext
  registerZimIpc(ctx)
  return { ctx, db, zimDir, auditCalls }
}

function addZimFile(dir: string, leaf: string): string {
  const p = join(dir, leaf)
  writeFileSync(p, 'ZIM')
  return p
}

beforeEach(() => {
  ipcState.handlers.clear()
})

describe('packs IPC', () => {
  it('adds packs via the main-side dialog and audits ids/counts ONLY', async () => {
    const h = makeHarness()
    ipcState.dialogPaths = [addZimFile(h.zimDir, `${FILE_SENTINEL}.zim`)]
    const added = (await invoke(handlers, IPC.addKnowledgePacks)).result as KnowledgePack[]
    expect(added).toHaveLength(1)
    expect(added[0]?.title).toContain(TITLE_SENTINEL)
    expect(h.auditCalls).toHaveLength(1)
    expect(h.auditCalls[0]?.type).toBe('knowledge_pack_added')
    // The ids-only privacy rule: neither the pack title nor its filename may ride the audit.
    const audited = JSON.stringify(h.auditCalls)
    expect(audited).not.toContain(TITLE_SENTINEL)
    expect(audited).not.toContain(FILE_SENTINEL)
    expect(h.auditCalls[0]?.metadata).toMatchObject({ articleCount: 42 })
  })

  it('returns null on a cancelled dialog and registers nothing', async () => {
    const h = makeHarness()
    ipcState.dialogCancel = true
    expect((await invoke(handlers, IPC.addKnowledgePacks)).result).toBeNull()
    expect(h.auditCalls).toHaveLength(0)
  })

  it('throws friendly copy when every chosen archive fails to register', async () => {
    const h = makeHarness()
    ipcState.dialogPaths = [addZimFile(h.zimDir, 'corrupt.zim')]
    await expect(invoke(handlers, IPC.addKnowledgePacks)).rejects.toThrow(/could not be added/)
    expect(h.auditCalls).toHaveLength(0)
  })

  it('list runs drive discovery first (drop a file in zim/, open the panel)', async () => {
    const h = makeHarness()
    addZimFile(h.zimDir, 'dropped.zim')
    const listed = (await invoke(handlers, IPC.listKnowledgePacks)).result as KnowledgePack[]
    expect(listed.map((p) => p.leaf)).toContain('dropped.zim')
  })

  it('remove audits the id; enable/disable round-trips', async () => {
    const h = makeHarness()
    ipcState.dialogPaths = [addZimFile(h.zimDir, 'a.zim')]
    const [pack] = (await invoke(handlers, IPC.addKnowledgePacks)).result as KnowledgePack[]
    await invoke(handlers, IPC.setKnowledgePackEnabled, pack!.id, false)
    expect(retrievablePacks(h.db, h.zimDir, [pack!.id])).toHaveLength(0)
    await invoke(handlers, IPC.removeKnowledgePack, pack!.id)
    expect(h.auditCalls.map((c) => c.type)).toContain('knowledge_pack_removed')
    expect((await invoke(handlers, IPC.listKnowledgePacks)).result as KnowledgePack[]).not.toContainEqual(
      expect.objectContaining({ id: pack!.id })
    )
  })

  it('status reports tools-not-installed when the service is absent', async () => {
    makeHarness()
    ipcState.handlers.clear()
    registerZimIpc({
      trustedSenders: ANY_SENDER,
      workspace: { isUnlocked: () => true }
    } as unknown as AppContext)
    expect((await invoke(handlers, IPC.getKnowledgePackStatus)).result).toEqual({
      toolsInstalled: false
    })
  })

  it('getPackArticle rejects malformed args with null, never a throw', async () => {
    makeHarness()
    expect((await invoke(handlers, IPC.getPackArticle, 42, null)).result).toBeNull()
  })
})

describe('scope round-trip', () => {
  it('packIds persist through setScope → resolveScope and survive narrowing spreads', () => {
    const h = makeHarness()
    const conv = createConversation(h.db, { mode: 'documents' })
    setScope(h.db, conv.id, { collectionIds: [], documentIds: [], packIds: ['uuid-a', 'uuid-b'] })
    const scope = resolveScope(h.db, conv.id)
    expect(scope.packIds).toEqual(['uuid-a', 'uuid-b'])
    // The rag handler narrows via spread ({ ...scope, … }) — packs must ride along.
    const narrowed = { ...scope, collectionIds: null, documentIds: ['doc-1'] }
    expect(narrowed.packIds).toEqual(['uuid-a', 'uuid-b'])
  })

  it('a pack-less scope serializes byte-identically to the pre-wave shape', () => {
    const h = makeHarness()
    const conv = createConversation(h.db, { mode: 'documents' })
    setScope(h.db, conv.id, { collectionIds: [], documentIds: ['d1'] })
    const row = h.db
      .prepare('SELECT scope_v2_json FROM conversations WHERE id = ?')
      .get(conv.id) as { scope_v2_json: string }
    expect(row.scope_v2_json).toBe('{"collectionIds":[],"documentIds":["d1"]}')
    expect(resolveScope(h.db, conv.id).packIds).toBeNull()
  })
})
