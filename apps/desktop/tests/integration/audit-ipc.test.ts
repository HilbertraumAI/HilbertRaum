import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

// Phase 19 IPC-layer tests (post-mvp-functionality-plan §7): the shallow audit wiring
// across the real IPC handlers, and above all the PRIVACY RULE — sentinel strings are
// seeded through the wired flows as chat content, document text, a non-privacy setting
// value, and a vault password, then every recorded `runtime_events` row is grepped to
// prove none of them was recorded. Plus the Activity surface: getAuditEvents paging and
// the export-to-file action. CI stays zero-network (injected fake fetch) and zero-model.

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  saveDialog: { canceled: true as boolean, filePath: undefined as string | undefined }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showSaveDialog: async () => ({
      canceled: ipcState.saveDialog.canceled,
      filePath: ipcState.saveDialog.filePath
    })
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerCoreIpc } from '../../src/main/ipc/registerCoreIpc'
import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { registerModelIpc } from '../../src/main/ipc/registerModelIpc'
import { registerDownloadIpc } from '../../src/main/ipc/registerDownloadIpc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { registerAuditIpc } from '../../src/main/ipc/registerAuditIpc'
import { DownloadManager } from '../../src/main/services/downloads'
import type { FetchFn } from '../../src/main/services/assets'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, updateSettings } from '../../src/main/services/settings'
import { createAuditRecorder, listAuditEvents, recordEvent } from '../../src/main/services/audit'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import {
  WorkspaceController,
  createEncryptedVaultOnDisk,
  vaultPathsFrom
} from '../../src/main/services/workspace-vault'
import type { KdfParams } from '../../src/main/services/security/crypto'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { ModelRuntime, ChatMessage } from '../../src/main/services/runtime'
import type { AppContext } from '../../src/main/services/context'
import type {
  AuditEvent,
  Conversation,
  DownloadJob,
  ImportJob,
  ImportJobStatus,
  Message,
  WorkspaceActionResult
} from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

const CHAT_SENTINEL = 'XCHAT_SENTINEL_my secret salary is 99999'
const DOC_SENTINEL = 'XDOC_SENTINEL_the merger closes friday'
const SETTING_SENTINEL = 'XSETTING_SENTINEL_not_privacy_relevant'
const PASSWORD_SENTINEL = 'XPASS_SENTINEL_hunter2hunter2'
const SENTINELS = [CHAT_SENTINEL, DOC_SENTINEL, SETTING_SENTINEL, PASSWORD_SENTINEL]

const BODY = 'downloaded-model-bytes'
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Echo runtime so chat content flows through the real chat handler glue. */
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

/** A drive root + DB + audit-wired ctx exercising the REAL handler registrations. */
function makeHarness(): Harness {
  const rootPath = mkdtempSync(join(tmpdir(), 'paid-auditipc-'))
  const workspacePath = join(rootPath, 'workspace')
  const configPath = join(rootPath, 'config')
  const manifestsDir = join(rootPath, 'model-manifests')
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(configPath, { recursive: true })
  mkdirSync(manifestsDir, { recursive: true })
  writeFileSync(
    join(manifestsDir, 'test-model.yaml'),
    stringify({
      id: 'test-model-q4',
      display_name: 'Test Model Q4',
      family: 'test',
      role: 'chat',
      format: 'gguf',
      runtime: 'llama_cpp',
      license: 'apache-2.0',
      size_on_disk_gb: 0.1,
      recommended_min_ram_gb: 1,
      recommended_ram_gb: 2,
      recommended_context_tokens: 4096,
      local_path: 'models/chat/test-model-q4.gguf',
      sha256: sha256(BODY),
      recommended_profiles: ['LITE'],
      license_review: { status: 'approved', reviewed_by: 't', reviewed_at: '2026-06-10', notes: '' },
      download: {
        url: 'https://example.test/test-model.gguf',
        sha256: sha256(BODY),
        size_bytes: BODY.length,
        license_url: 'https://example.test/license'
      }
    })
  )

  const db = openDatabase(join(workspacePath, 'test.sqlite'))
  seedSettings(db)
  const audit = createAuditRecorder(() => db)
  const runtime = echoRuntime()
  const ctx = {
    paths: { rootPath, workspacePath, configPath },
    db,
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    runtime: {
      active: () => runtime,
      activeModelId: () => runtime.modelId,
      start: async () => ({
        running: true,
        modelId: 'test-model-q4',
        port: null,
        healthy: true,
        message: 'ok',
        backend: 'mock'
      }),
      stop: async () => {}
    },
    embedder: createMockEmbedder(),
    manifestsDir,
    isDev: true,
    audit
  } as unknown as AppContext
  return { ctx, db, rootPath }
}

function allRowsText(db: Db): string {
  const rows = db
    .prepare(
      "SELECT event_type || ' ' || message || ' ' || COALESCE(metadata_json, '') AS t FROM runtime_events"
    )
    .all() as Array<{ t: string }>
  return rows.map((r) => r.t).join('\n')
}

function eventTypes(db: Db): string[] {
  return listAuditEvents(db, { limit: 5000 }).map((e) => e.type)
}

async function pollUntil(check: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const okFetch = (async () =>
  new Response(BODY, {
    status: 200,
    headers: { 'content-length': String(BODY.length) }
  })) as unknown as FetchFn

beforeEach(() => {
  ipcState.handlers.clear()
  ipcState.saveDialog.canceled = true
  ipcState.saveDialog.filePath = undefined
  inFlightStreams.clear()
})

describe('audit wiring across the IPC layer (privacy sentinel grep)', () => {
  it('records the shallow events and NEVER the seeded chat/document/setting content', async () => {
    const { ctx, db, rootPath } = makeHarness()
    registerCoreIpc(ctx)
    registerChatIpc(ctx)
    registerDocsIpc(ctx)
    registerModelIpc(ctx)
    registerDownloadIpc(
      ctx,
      new DownloadManager({
        fetchImpl: okFetch,
        audit: (type, message, metadata) => ctx.audit?.(type, message, metadata)
      })
    )

    // -- settings: a privacy-relevant key + a sentinel value on a NON-privacy key.
    await invoke(handlers, IPC.updateSettings, {
      allowNetwork: true,
      gpuLastError: SETTING_SENTINEL
    })

    // -- chat: sentinel content streams through the real chat path, then export+delete.
    const { result: convRaw } = await invoke(handlers, IPC.createConversation, {})
    const conv = convRaw as Conversation
    const { result: replyRaw } = await invoke(handlers, IPC.sendChatMessage, conv.id, CHAT_SENTINEL)
    expect((replyRaw as Message).content).toContain(CHAT_SENTINEL) // the flow really carried it
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = join(rootPath, 'transcript.md')
    await invoke(handlers, IPC.exportConversation, conv.id)
    await invoke(handlers, IPC.deleteConversation, conv.id)

    // -- documents: sentinel text inside the file body (the FILENAME is fair game).
    const docPath = join(rootPath, 'meeting-notes.txt')
    writeFileSync(docPath, `notes\n${DOC_SENTINEL}\n`, 'utf8')
    const { result: jobRaw } = await invoke(handlers, IPC.importDocuments, [docPath])
    const job = jobRaw as ImportJob
    await pollUntil(async () => {
      const { result } = await invoke(handlers, IPC.getImportJob, job.jobId)
      return (result as ImportJobStatus).done
    }, 'import job')
    const documentId = job.documentIds[0]
    await invoke(handlers, IPC.reindexDocument, documentId)
    await invoke(handlers, IPC.deleteDocument, documentId)

    // -- models + runtime: select, verify, start (mock fallback), stop.
    await invoke(handlers, IPC.selectModel, 'test-model-q4')
    await invoke(handlers, IPC.verifyModel, 'test-model-q4')
    await invoke(handlers, IPC.startRuntime, 'test-model-q4')
    await invoke(handlers, IPC.stopRuntime)

    // -- download (Phase-18 follow-up): started + verified through the injected hook.
    const { result: dlRaw } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const dl = dlRaw as DownloadJob
    await pollUntil(async () => {
      const { result } = await invoke(handlers, IPC.getDownloadJob, dl.jobId)
      const j = result as DownloadJob
      return j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
    }, 'download job')

    // Every expected shallow event landed…
    const types = eventTypes(db)
    for (const expected of [
      'settings_changed',
      'conversation_exported',
      'conversation_deleted',
      'document_imported',
      'document_reindexed',
      'document_deleted',
      'model_selected',
      'model_verified',
      'runtime_started',
      'runtime_stopped',
      'model_download_started',
      'model_download_verified'
    ]) {
      expect(types, `missing audit event: ${expected}`).toContain(expected)
    }

    // …and NO sentinel content did (the privacy rule, spec §7.11 + plan §7).
    const recorded = allRowsText(db)
    for (const sentinel of SENTINELS) {
      expect(recorded).not.toContain(sentinel)
    }
    // The settings event carries the privacy-relevant key + value, nothing else.
    const settingsEvent = listAuditEvents(db, { limit: 5000 }).find(
      (e) => e.type === 'settings_changed'
    )
    expect(settingsEvent?.metadata).toEqual({ allowNetwork: true })

    // The filename (allowed) is on record; the document text is not.
    expect(recorded).toContain('meeting-notes')
  })

  it('document and conversation flows do not fire audit events on refused operations', async () => {
    const { ctx, db } = makeHarness()
    registerChatIpc(ctx)
    await expect(invoke(handlers, IPC.deleteConversation, 'nope')).resolves.toBeTruthy()
    // Unknown conversation: deleteConversation is a no-op delete — but no stream guard
    // tripped, so the (harmless) audit event may record. The real guard: a refused
    // delete while streaming records nothing.
    inFlightStreams.set('busy-conv', new AbortController())
    await expect(invoke(handlers, IPC.deleteConversation, 'busy-conv')).rejects.toThrow(
      /still being generated/
    )
    const types = eventTypes(db)
    expect(types.filter((t) => t === 'conversation_deleted')).toHaveLength(1)
  })
})

describe('workspace audit events (buffered while locked, flushed after unlock)', () => {
  const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

  it('unlock failures recorded while locked appear after the next successful unlock — never the password', async () => {
    const root = mkdtempSync(join(tmpdir(), 'paid-auditws-'))
    mkdirSync(join(root, 'config'), { recursive: true })
    mkdirSync(join(root, 'workspace'), { recursive: true })
    const vault = vaultPathsFrom({
      configPath: join(root, 'config'),
      dbPath: join(root, 'workspace', 'paid.sqlite')
    })
    createEncryptedVaultOnDisk(vault, PASSWORD_SENTINEL, FAST_KDF)
    const ctrl = new WorkspaceController(vault, DEFAULT_POLICY, false)
    ctrl.init()

    const ctx = {
      workspace: ctrl,
      runtime: { stop: async () => {}, active: () => null, activeModelId: () => null },
      embedder: { stop: async () => {} },
      manifestsDir: null,
      audit: createAuditRecorder(() => ctrl.requireDb())
    } as unknown as AppContext
    registerWorkspaceIpc(ctx)

    const { result: failed } = await invoke(handlers, IPC.unlockWorkspace, 'wrong-password-1')
    expect((failed as WorkspaceActionResult).ok).toBe(false)

    const { result: ok } = await invoke(handlers, IPC.unlockWorkspace, PASSWORD_SENTINEL)
    expect((ok as WorkspaceActionResult).ok).toBe(true)

    const db = ctrl.requireDb()
    const types = eventTypes(db)
    expect(types).toContain('workspace_unlock_failed')
    expect(types).toContain('workspace_unlocked')
    const recorded = allRowsText(db)
    expect(recorded).not.toContain(PASSWORD_SENTINEL)
    expect(recorded).not.toContain('wrong-password-1')
  })
})

describe('the Activity surface (getAuditEvents + exportAuditLog)', () => {
  it('pages newest-first over IPC with the beforeId cursor', async () => {
    const { ctx, db } = makeHarness()
    registerAuditIpc(ctx)
    const at = (n: number): string => new Date(Date.UTC(2026, 5, 10, 12, 0, 0, n)).toISOString()
    for (let i = 1; i <= 5; i++) {
      recordEvent(db, 'model_selected', `event ${i}`, undefined, at(i))
    }
    const { result: page1 } = await invoke(handlers, IPC.getAuditEvents, 2)
    expect((page1 as AuditEvent[]).map((e) => e.message)).toEqual(['event 5', 'event 4'])
    const cursor = (page1 as AuditEvent[])[1].id
    const { result: page2 } = await invoke(handlers, IPC.getAuditEvents, 2, cursor)
    expect((page2 as AuditEvent[]).map((e) => e.message)).toEqual(['event 3', 'event 2'])
  })

  it('exports the log to the chosen file; cancel returns null', async () => {
    const { ctx, db, rootPath } = makeHarness()
    registerAuditIpc(ctx)
    recordEvent(db, 'model_selected', 'Model selected: test-model-q4', { modelId: 'test-model-q4' })

    const { result: cancelled } = await invoke(handlers, IPC.exportAuditLog)
    expect(cancelled).toBeNull()

    const outPath = join(rootPath, 'activity-log.json')
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = outPath
    const { result: saved } = await invoke(handlers, IPC.exportAuditLog)
    expect(saved).toBe(outPath)
    const exported = JSON.parse(readFileSync(outPath, 'utf8')) as AuditEvent[]
    expect(exported).toHaveLength(1)
    expect(exported[0]).toMatchObject({
      type: 'model_selected',
      metadata: { modelId: 'test-model-q4' }
    })
  })
})
