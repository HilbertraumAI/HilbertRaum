import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer tests for registerWorkspaceIpc — the exception→result mapping the unlock gate
// depends on (a wrong password / policy refusal / weak password must be a NORMAL
// `{ ok:false, reason }` result, not a thrown error) and the MIN_PASSWORD_LENGTH floor.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

// T2 (post-merge audit Phase 5): the resident decoded-vector cache lock-PURGE is a stated SECURITY
// requirement (RAG-6) — chunk-text-derived vectors must not linger in main-process RAM after the
// vault re-encrypts — but it was only proven at the unit tier, never that the lock IPC actually
// CALLS it. Spy on `purgeResidentVectors` (calling THROUGH to the real impl, sharing the real
// `caches` singleton, mirroring the resident-cache-incremental decode-spy idiom) so the lock
// handler's WIRING is asserted at the IPC layer. The other lock tests above run with `ctx.db`
// undefined → harmless `purge(undefined)` no-ops, so the spy is mockClear'd per assertion below.
const { purgeSpy } = vi.hoisted(() => ({ purgeSpy: vi.fn() }))
vi.mock('../../src/main/services/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/embeddings')>()
  purgeSpy.mockImplementation(actual.purgeResidentVectors)
  return { ...actual, purgeResidentVectors: purgeSpy }
})

import { randomUUID } from 'node:crypto'
import { encodeVector, getResidentVectors } from '../../src/main/services/embeddings'
import { inFlightStreams, streamSettled } from '../../src/main/ipc/inflight'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy, WorkspaceActionResult } from '../../src/shared/types'
import {
  WorkspaceController,
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-wsipc-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  return vaultPathsFrom({ configPath: join(root, 'config'), dbPath: join(root, 'workspace', 'hilbertraum.sqlite') })
}

function ctxWith(
  ctrl: WorkspaceController,
  sidecars?: {
    stopRuntime?: () => Promise<void>
    stopEmbedder?: () => Promise<void>
    stopVision?: () => Promise<void>
  }
): AppContext {
  return {
    workspace: ctrl,
    runtime: { stop: sidecars?.stopRuntime ?? (async () => {}), activeModelId: () => null },
    embedder: { stop: sidecars?.stopEmbedder ?? (async () => {}) },
    ...(sidecars?.stopVision ? { vision: { stop: sidecars.stopVision } } : {})
  } as unknown as AppContext
}

beforeEach(() => ipcState.handlers.clear())

describe('registerWorkspaceIpc', () => {
  it('refuses a too-short encrypted password as a normal result (no throw, no KDF)', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.createWorkspace, 'short', 'encrypted')
    const r = result as WorkspaceActionResult
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'refused' })
    expect((r as { message: string }).message).toMatch(/at least 8/)
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('creates an encrypted workspace with a long-enough password', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.createWorkspace, 'longenough', 'encrypted')
    const r = result as WorkspaceActionResult
    expect(r.ok).toBe(true)
    expect(r.ok && r.state.state).toBe('unlocked')
    expect(r.ok && r.state.mode).toBe('encrypted')
    ctrl.lock()
  })

  it('maps a wrong password to { ok:false, reason:"wrong_password" } instead of throwing', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF) // descriptor uses FAST params
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    expect(ctrl.getState().state).toBe('locked')
    registerWorkspaceIpc(ctxWith(ctrl))

    const { result } = await invoke(handlers, IPC.unlockWorkspace, 'wrong-password')
    expect(result).toMatchObject({ ok: false, reason: 'wrong_password' })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  // M-S2: the renderer is the untrusted boundary — a non-string password must NOT throw
  // an unhandled TypeError at the IPC layer (password.length used to run before the try).
  it('handles a non-string create password as a clean refusal (no throw)', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    // A throwing handler would reject this await — the no-throw guarantee IS the test.
    const { result } = await invoke(handlers, IPC.createWorkspace, 12345 as unknown as string, 'encrypted')
    expect(result).toMatchObject({ ok: false, reason: 'refused' })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('rejects an unknown create mode as a clean result (no throw)', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.createWorkspace, 'longenough', 'bogus' as never)
    expect(result).toMatchObject({ ok: false })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('handles a non-string unlock password as wrong_password (no throw)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.unlockWorkspace, { evil: true } as unknown as string)
    expect(result).toMatchObject({ ok: false, reason: 'wrong_password' })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('maps a policy-forbidden plaintext create to { ok:false, reason:"refused" }', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, true)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.createWorkspace, 'whatever8', 'plaintext_dev')
    expect(result).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('returns the current workspace state', async () => {
    const ctrl = new WorkspaceController(freshVault(), DEFAULT_POLICY, true) // dev → plaintext opens
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.getWorkspaceState)
    expect(result).toMatchObject({ state: 'unlocked', mode: 'plaintext_dev' })
  })

  it('lockWorkspace stops both sidecars before re-encrypting (Lock now)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const order: string[] = []
    const stopRuntime = vi.fn(async () => {
      order.push('runtime')
    })
    const stopEmbedder = vi.fn(async () => {
      order.push('embedder')
    })
    registerWorkspaceIpc(ctxWith(ctrl, { stopRuntime, stopEmbedder }))

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(ctrl.isUnlocked()).toBe(false)
    expect(stopRuntime).toHaveBeenCalledTimes(1)
    expect(stopEmbedder).toHaveBeenCalledTimes(1)
    // Both sidecars were stopped (order between them doesn't matter, but both ran).
    expect(order.sort()).toEqual(['embedder', 'runtime'])
  })

  it('lockWorkspace stops the vision sidecar too (its KV cache holds the image + prompt)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const stopVision = vi.fn(async () => {})
    registerWorkspaceIpc(ctxWith(ctrl, { stopVision }))

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(stopVision).toHaveBeenCalledTimes(1)
  })

  it('lockWorkspace suspends the translator AND cancels the active doc task (TG-3)', async () => {
    // A running TRANSLATION no longer dies with the chat runtime: left uncancelled, its
    // next window would lazily RESPAWN the suspended TranslateGemma sidecar with document
    // plaintext while the vault re-encrypts. The lock handler must cancel the active task
    // (any non-yielding kind) and suspend — not permanently stop — the translator.
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const suspendTranslator = vi.fn(async () => {})
    const stopTranslator = vi.fn(async () => {})
    const cancelDocTask = vi.fn()
    const abortActiveBuild = vi.fn()
    const base = ctxWith(ctrl) as unknown as Record<string, unknown>
    base.translator = { suspend: suspendTranslator, stop: stopTranslator }
    base.docTasks = { cancelDocTask, abortActiveBuild }
    registerWorkspaceIpc(base as unknown as AppContext)

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(abortActiveBuild).toHaveBeenCalledTimes(1)
    expect(cancelDocTask).toHaveBeenCalledTimes(1)
    expect(suspendTranslator).toHaveBeenCalledTimes(1)
    expect(stopTranslator).not.toHaveBeenCalled() // stop() latches permanently — lock must not
  })

  it('lockWorkspace still locks when a sidecar stop fails (allSettled)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    registerWorkspaceIpc(
      ctxWith(ctrl, {
        stopRuntime: async () => {
          throw new Error('sidecar wedged')
        }
      })
    )
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('lockWorkspace purges the resident decoded-vector cache (RAG-6 security wiring, T2)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const db = ctrl.requireDb()

    // Seed a REAL resident decoded-vector map for this db (doc → chunk → embedding), so the lock
    // purge has a genuine chunk-text-derived buffer to drop — not an empty no-op.
    const now = new Date().toISOString()
    const docId = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
    ).run(docId, 'doc', now, now)
    const chunkId = randomUUID()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
       VALUES (?, ?, 0, ?, ?, 1, ?)`
    ).run(chunkId, docId, 'hello', 'doc', now)
    const vec = new Float32Array([1, 0, 0, 0])
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, 'mock', encodeVector(vec), vec.length, now)
    expect(getResidentVectors(db).size).toBe(1) // the decoded vector is resident in main-process RAM

    // The lock handler reads ctx.db at call time — give it the LIVE workspace db so the purge
    // target is the genuine cache key, not undefined.
    registerWorkspaceIpc({ ...ctxWith(ctrl), db } as unknown as AppContext)
    purgeSpy.mockClear() // ignore any earlier lock tests' purge(undefined) no-ops
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })

    // RAG-6 SECURITY purge: the lock handler dropped the resident map, wired to the LIVE db,
    // before the vault re-encrypted. A refactor that stops calling it reddens here (teeth-checked).
    // Assert the captured arg by REFERENCE (`toBe`) — `toHaveBeenCalledWith` would deep-compare the
    // now-closed db, whose `isTransaction` getter throws "database is not open".
    expect(purgeSpy).toHaveBeenCalledTimes(1)
    expect(purgeSpy.mock.calls[0][0]).toBe(db)
  })

  // R1 (full-audit-2026-06-30, Phase C): lockWorkspace aborts in-flight streams, then must AWAIT
  // each stream's SETTLE (its abort-unwind partial-reply persistence) BEFORE purge/lock close the
  // DB — instead of relying on runtime.stop() outrunning the abort-unwind. The lock handler reads
  // the module-singleton inFlightStreams + streamSettled, so this populates those directly.
  it('lockWorkspace awaits each in-flight stream settle before re-encrypting (R1)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const db = ctrl.requireDb()
    expect(ctrl.isUnlocked()).toBe(true)

    const controller = new AbortController()
    let persist!: () => void
    const persisted = { done: false }
    inFlightStreams.set('c1', controller)
    streamSettled.set(
      'c1',
      new Promise<void>((r) => {
        persist = () => {
          persisted.done = true
          r()
        }
      })
    )

    try {
      registerWorkspaceIpc({ ...ctxWith(ctrl), db } as unknown as AppContext)
      const lockP = invoke(handlers, IPC.lockWorkspace)

      const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
      await tick()
      await tick()
      await tick()
      // The stream was aborted, but the DB is STILL OPEN — lock is blocked on the pending settle.
      expect(controller.signal.aborted).toBe(true)
      expect(persisted.done).toBe(false)
      expect(ctrl.isUnlocked()).toBe(true) // reds if the settle-await is removed (DB already closed)

      persist() // the partial finished persisting → settle resolves
      const { result } = await lockP
      expect(result).toMatchObject({ state: 'locked' })
      expect(ctrl.isUnlocked()).toBe(false) // re-encrypted only AFTER the settle
    } finally {
      inFlightStreams.delete('c1')
      streamSettled.delete('c1')
    }
  })
})
