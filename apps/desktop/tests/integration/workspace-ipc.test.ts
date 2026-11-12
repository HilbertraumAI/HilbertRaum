import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

import { randomBytes, randomUUID } from 'node:crypto'
import { encodeVector, getResidentVectors } from '../../src/main/services/embeddings'
import type { IpcMainInvokeEvent } from 'electron'
import { inFlightStreams, streamSettled } from '../../src/main/ipc/inflight'
import { withChatStream, withRegenerateGuard } from '../../src/main/ipc/chat-stream'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { appendMessage, createConversation, generateAssistantMessage, listMessages } from '../../src/main/services/chat'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy, WorkspaceActionResult } from '../../src/shared/types'
import {
  WorkspaceController,
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  unlockEncryptedVault,
  lockEncryptedVault,
  encryptFile,
  VaultRecoveryBlockedError,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { SCHEMA_VERSION } from '../../src/main/services/db'
import { applyUiLanguageSetting, mainUiLanguage, tMain } from '../../src/main/services/i18n'
import { UI_LANGUAGE_CODES, type MessageKey } from '../../src/shared/i18n'
import {
  CREATE_FAILURE_KEYS,
  UNLOCK_FAILURE_KEYS,
  type WorkspaceFailureReason
} from '../../src/shared/workspace-failure-keys'
import { catalogOf } from '../helpers/i18n-catalogs'
import { openRawDb } from '../helpers/db-fixtures'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { buildToolRunner } from '../../src/main/services/skills/tool-runs'
import { SkillRunController } from '../../src/main/services/skills/run-controller'
import { seedStoredTextDoc } from '../helpers/doc-fixtures'
import { killableRuntime } from '../helpers/killable-runtime'

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

/** #208's on-disk state: the password verifies and `.enc` authenticates, but it holds our own
 *  encryption of pure noise under the real key, not a database. */
function damagedVault(password: string): VaultPaths {
  const vp = freshVault()
  createEncryptedVaultOnDisk(vp, password, FAST_KDF)
  const { db, key } = unlockEncryptedVault(vp, password)
  lockEncryptedVault(vp, db, key)
  const noise = `${vp.dbPath}.noise-src`
  writeFileSync(noise, randomBytes(64 * 1024))
  encryptFile(noise, vp.encPath, key)
  return vp
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
    trustedSenders: ANY_SENDER,
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

  // #208: a vault whose `.enc` authenticates but does not decrypt to a database must NOT
  // wear the wrong-password (or generic openFailed) copy — the reporter's destroyed vault
  // looked like a forgotten password across three releases, and the troubleshooting step
  // that suggests ("create a new workspace") erases the recovery evidence.
  it('maps a damaged vault to { ok:false, reason:"vault_damaged" }, distinct from wrong_password', async () => {
    const vp = damagedVault('right-password')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))

    const wrong = await invoke(handlers, IPC.unlockWorkspace, 'wrong-password')
    expect(wrong.result).toMatchObject({ ok: false, reason: 'wrong_password' })

    const { result } = await invoke(handlers, IPC.unlockWorkspace, 'right-password')
    expect(result).toMatchObject({ ok: false, reason: 'vault_damaged' })
    // The copy must carry the damage + backup guidance, not the "check it and try again"
    // retry framing of the wrong-password copy.
    expect((result as { message: string }).message).toMatch(/damaged/i)
    expect((result as { message: string }).message).toMatch(/backup/i)
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

  // BE-5 (ocr-audit 2026-07-18): the idle warm tesseract WASM worker holds decoded page bytes in
  // main-process RAM, so the lock must terminate it before the vault re-encrypts. `suspend()` (not
  // `stop()`): the engine is held on ctx for the session, so it must come back lazily after unlock;
  // stop() latches permanently. Watched fail pre-fix (the lock teardown omitted the OCR engine).
  it('lockWorkspace suspends the OCR engine too (an idle worker holds decoded page bytes)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const suspendOcr = vi.fn(async () => {})
    const stopOcr = vi.fn(async () => {})
    const base = ctxWith(ctrl) as unknown as Record<string, unknown>
    base.ocrEngine = { suspend: suspendOcr, stop: stopOcr }
    registerWorkspaceIpc(base as unknown as AppContext)

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(suspendOcr).toHaveBeenCalledTimes(1)
    expect(stopOcr).not.toHaveBeenCalled() // stop() latches permanently — lock must not
  })

  it('lockWorkspace suspends the translator, FLUSHES the doc-task queue (TA-1 H2) AND aborts the Translate-view job (TG-4)', async () => {
    // A running TRANSLATION no longer dies with the chat runtime: left uncancelled, its
    // next window would lazily RESPAWN the suspended TranslateGemma sidecar with document
    // plaintext while the vault re-encrypts. TA-1 H2: the handler must flush the WHOLE
    // pipeline — `cancelAllDocTasks()` (running + queued), NOT `cancelDocTask()` (active only)
    // — because a queued translation would otherwise dequeue into the still-open lock window.
    // It must suspend — not permanently stop — the translator, and await the running task's
    // settle. TG-4: a running Translate-VIEW job (`ctx.translateJobs`) shares the same sidecar,
    // so it is aborted here too (its next window would likewise respawn the suspended server).
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const suspendTranslator = vi.fn(async () => {})
    const stopTranslator = vi.fn(async () => {})
    const cancelAllDocTasks = vi.fn()
    const awaitActiveTaskSettled = vi.fn(async () => {})
    const abortActiveBuild = vi.fn()
    const stopTranslateJobs = vi.fn(async () => {})
    const base = ctxWith(ctrl) as unknown as Record<string, unknown>
    base.translator = { suspend: suspendTranslator, stop: stopTranslator }
    base.docTasks = { cancelAllDocTasks, awaitActiveTaskSettled, abortActiveBuild }
    base.translateJobs = { stop: stopTranslateJobs }
    registerWorkspaceIpc(base as unknown as AppContext)

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(abortActiveBuild).toHaveBeenCalledTimes(1)
    // TA-1 H2: the whole pipeline is flushed (running + queued), and the running task's
    // abort-unwind settle is awaited before the vault re-encrypts.
    expect(cancelAllDocTasks).toHaveBeenCalledTimes(1)
    expect(awaitActiveTaskSettled).toHaveBeenCalledTimes(1)
    // TG-4: the view job is aborted, and BEFORE the translator suspend (its abort loop is
    // synchronous, so a queued next window can't reach translate() after the sidecar dies).
    expect(stopTranslateJobs).toHaveBeenCalledTimes(1)
    expect(suspendTranslator).toHaveBeenCalledTimes(1)
    expect(stopTranslator).not.toHaveBeenCalled() // stop() latches permanently — lock must not
  })

  // TA-1 H2: the lock handler awaits the flushed running task's abort-unwind SETTLE (its
  // materialize/shred runs synchronously while ctx.db is open) BEFORE the vault re-encrypts —
  // mirroring the in-flight-stream settle. A deferred settle must block lock() until it resolves.
  // #606: the cancelled skill runs too — each records its cancel in `skill_runs` while the DB is open.
  it.each([
    [
      'doc-task (TA-1 H2)',
      (base: Record<string, unknown>, settle: () => Promise<void>) => {
        const cancel = vi.fn()
        base.docTasks = { cancelAllDocTasks: cancel, awaitActiveTaskSettled: settle, abortActiveBuild: vi.fn() }
        return cancel
      }
    ],
    [
      'skill-run (#606)',
      (base: Record<string, unknown>, settle: () => Promise<void>) => {
        const cancel = vi.fn()
        base.skillRuns = { cancelAll: cancel, cancelModelRuns: vi.fn(), awaitSettled: () => settle().then(() => true) }
        return cancel
      }
    ]
  ])('lockWorkspace awaits the cancelled %s settle before re-encrypting', async (_lane, install) => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    expect(ctrl.isUnlocked()).toBe(true)

    let unwind!: () => void
    const settled = { done: false }
    const base = ctxWith(ctrl) as unknown as Record<string, unknown>
    const cancel = install(
      base,
      () =>
        new Promise<void>((r) => {
          unwind = () => {
            settled.done = true
            r()
          }
        })
    )
    registerWorkspaceIpc(base as unknown as AppContext)

    const lockP = invoke(handlers, IPC.lockWorkspace)
    const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
    await tick()
    await tick()
    await tick()
    // The work was cancelled, but the DB is STILL OPEN — lock is blocked on the pending settle.
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(settled.done).toBe(false)
    expect(ctrl.isUnlocked()).toBe(true) // reds if the settle-await is removed (DB already closed)

    unwind() // the aborted task / run finished unwinding (its DB writes) → settle resolves
    const { result } = await lockP
    expect(result).toMatchObject({ state: 'locked' })
    expect(ctrl.isUnlocked()).toBe(false) // re-encrypted only AFTER the settle
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

  // #612: "Lock now" mid-answer saved the partial with nothing to say it was cut, so after the next
  // unlock it read as a finished answer. Driven end to end: a real chat turn through the stream
  // lifecycle on the unlocked vault's database, the lock handler, then a fresh unlock that reads it back.
  it('lockWorkspace ends an in-flight answer so it still reads "Reply stopped" after the next unlock (#612)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const db = ctrl.requireDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Tell me about lighthouses.' })

    // Streams two tokens, then waits on the next read until its signal aborts (a clean return, as the
    // real reader ends on an abort).
    let markParked!: () => void
    const parked = new Promise<void>((r) => (markParked = r))
    const runtime: ModelRuntime = {
      modelId: 'mock',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      contextWindow: () => 4096,
      async *chatStream(_m: ChatMessage[], opts?: RuntimeChatOptions) {
        yield 'Lighthouses '
        yield 'guide ships'
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
          markParked()
        })
      }
    }
    const event = { sender: { isDestroyed: () => false, send: () => {} } } as unknown as IpcMainInvokeEvent
    const turn = withChatStream(
      event,
      conv.id,
      'Chat generation failed',
      withRegenerateGuard(db, conv.id, false, (signal, sendToken) =>
        generateAssistantMessage(db, runtime, conv.id, { signal, onToken: sendToken })
      )
    )
    await parked

    registerWorkspaceIpc({ ...ctxWith(ctrl), db } as unknown as AppContext)
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    await expect(turn).resolves.toMatchObject({ content: 'Lighthouses guide ships', endedEarly: 'lock' })

    ctrl.unlock('right-password')
    try {
      const saved = listMessages(ctrl.requireDb(), conv.id)
      expect(saved.map((m) => [m.role, m.content, m.endedEarly])).toEqual([
        ['user', 'Tell me about lighthouses.', undefined],
        ['assistant', 'Lighthouses guide ships', 'lock']
      ])
    } finally {
      ctrl.lock()
    }
  })

  // #606: "Lock now" stopped the chat model under a running skill run and under the benchmark's speed
  // leg, whose own signals were untouched. A redaction whose locate request died with the sidecar fell
  // back to the rule-based floor and opened its save dialog over the lock screen (real app, 2026-10-06).
  // Driven with the real redaction seam and run controller on the unlocked vault's database.
  it('lockWorkspace cancels a skill run and the benchmark before it stops the model; nothing is saved (#606)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const db = ctrl.requireDb()
    const documentId = seedStoredTextDoc(db, 'Anna Berger lives at Lindenweg 4 in Freiburg.', { label: 'wsipc' })

    let markParked!: () => void
    const parked = new Promise<void>((r) => (markParked = r))
    const model = killableRuntime({ onParked: markParked })
    const saveTextFile = vi.fn(async () => true)
    const runner = buildToolRunner(
      db,
      'redact_document',
      { skillInstallId: 'app:document-redaction', conversationId: '', documentId, confirmed: true },
      () => {},
      { saveTextFile, runtime: model }
    )!
    const runs = new SkillRunController()
    const { runHandle } = runs.start({
      skillInstallId: 'app:document-redaction',
      toolName: 'redact_document',
      documentId,
      documentCount: 1,
      usesModel: true,
      runner
    })
    await parked // the locate pass's model request is in flight

    const order: string[] = []
    const stopRuntime = async (): Promise<void> => {
      order.push('runtime.stop')
      await model.stop()
    }
    registerWorkspaceIpc({
      ...ctxWith(ctrl, { stopRuntime }),
      db,
      skillRuns: runs,
      cancelBenchmark: () => order.push('benchmark.cancel')
    } as unknown as AppContext)
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })

    expect(runs.get(runHandle)?.state).toBe('cancelled')
    expect(saveTextFile).not.toHaveBeenCalled() // before #606: the rule-based copy's save dialog
    expect(order).toEqual(['benchmark.cancel', 'runtime.stop'])
    ctrl.unlock('right-password')
    try {
      // Recorded before the vault re-encrypted (before #606 a late write failed: "could not be saved").
      expect(ctrl.requireDb().prepare('SELECT status FROM skill_runs').all()).toEqual([{ status: 'cancelled' }])
    } finally {
      ctrl.lock()
    }
  })
})

// UI-languages owner call D-17 (a), and /code-review high on PR-A (#3): the first-run gate shows a
// failed unlock or create in ITS language, from `reason`, with the key its tables
// (`shared/workspace-failure-keys.ts`) hold: a copy of the choice each branch of the handlers
// makes. The gate's own rows stub main's answer, so main moving a reason to another key would turn
// nothing red there while the gate kept showing the old copy. These rows drive the REAL handlers
// into every branch that answers each reason and hold main's `message` against the gate's table,
// once for every language main can speak (equal text in all of them stands in for the same key).
// Where a table holds `null` the gate shows main's `message` as it came, which keeps the screen in
// one language only while that message is free text: the same in every language, and no catalog
// value.
describe('main’s unlock/create failure copy is the copy the gate’s tables pick (UI-languages owner call D-17 (a))', () => {
  type Call = 'unlock' | 'create'
  /** One way into a branch of a handler: the workspace it sees and the arguments it gets. */
  interface Provocation {
    how: string
    arrange: () => { workspace: WorkspaceController; args: readonly unknown[] }
  }
  /** The call never answers this reason: nothing to drive (the gate's table holds `null`). */
  const NEVER_SENT = 'never sent'
  /** Typecheck makes every reason either driven (at least once) or declared never sent. */
  type Provocations = Record<WorkspaceFailureReason, readonly [Provocation, ...Provocation[]] | typeof NEVER_SENT>

  const PW = 'right-password'
  const startedOn = (vp: VaultPaths, policy = ENCRYPTION_REQUIRED, devMode = false): WorkspaceController => {
    const ctrl = new WorkspaceController(vp, policy, devMode)
    ctrl.init()
    return ctrl
  }
  const lockedVault = (): VaultPaths => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, PW, FAST_KDF)
    return vp
  }
  /** Databases a newer build stamped (#247, as in workspace-newer.test.ts). */
  const newerVault = (): VaultPaths => {
    const vp = lockedVault()
    const { db, key } = unlockEncryptedVault(vp, PW)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
    lockEncryptedVault(vp, db, key)
    return vp
  }
  const newerPlaintext = (): VaultPaths => {
    const vp = freshVault()
    const raw = openRawDb(vp.dbPath)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
    raw.close()
    return vp
  }

  const UNLOCK: Provocations = {
    wrong_password: [
      { how: 'a wrong password', arrange: () => ({ workspace: startedOn(lockedVault()), args: ['wrong-password'] }) },
      {
        how: 'a password that is not a string',
        arrange: () => ({ workspace: startedOn(lockedVault()), args: [{ evil: true }] })
      }
    ],
    vault_damaged: [
      { how: 'a vault that decrypts to noise', arrange: () => ({ workspace: startedOn(damagedVault(PW)), args: [PW] }) }
    ],
    // A real hold takes an `fs` mock (vault-recovery-guards.test.ts drives one into this handler);
    // the handler only sees the controller's typed refusal, so a workspace whose unlock throws it
    // reaches the same branch.
    vault_recovery_blocked: [
      {
        how: 'a recovery file another program holds',
        arrange: () => ({
          workspace: {
            unlock: () => {
              throw new VaultRecoveryBlockedError()
            }
          } as unknown as WorkspaceController,
          args: [PW]
        })
      }
    ],
    workspace_newer: [
      { how: 'a database a newer build stamped', arrange: () => ({ workspace: startedOn(newerVault()), args: [PW] }) }
    ],
    refused: NEVER_SENT,
    error: [{ how: 'no vault to unlock', arrange: () => ({ workspace: startedOn(freshVault()), args: [PW] }) }]
  }

  const CREATE: Provocations = {
    wrong_password: NEVER_SENT,
    vault_damaged: NEVER_SENT,
    vault_recovery_blocked: NEVER_SENT,
    workspace_newer: [
      {
        how: 'a plaintext database a newer build stamped',
        arrange: () => ({ workspace: startedOn(newerPlaintext(), DEFAULT_POLICY, true), args: ['', 'plaintext_dev'] })
      }
    ],
    // Not a row: main's too-short refusal (a password under MIN_PASSWORD_LENGTH, or not a string),
    // which does carry a catalog sentence. The gate never sends one (WorkspaceGate.test.tsx,
    // "enables Create exactly at the shared floor main enforces").
    refused: [
      {
        how: 'a plaintext workspace the policy forbids',
        arrange: () => ({
          workspace: startedOn(freshVault(), ENCRYPTION_REQUIRED, true),
          args: ['whatever8', 'plaintext_dev']
        })
      },
      {
        how: 'a vault already on the drive',
        arrange: () => ({ workspace: startedOn(lockedVault()), args: ['longenough', 'encrypted'] })
      }
    ],
    error: [
      { how: 'an unknown mode', arrange: () => ({ workspace: startedOn(freshVault()), args: ['longenough', 'bogus'] }) },
      {
        how: 'a workspace already open',
        arrange: () => ({ workspace: startedOn(freshVault(), DEFAULT_POLICY, true), args: ['', 'plaintext_dev'] })
      }
    ]
  }

  type Row = [Call, WorkspaceFailureReason, string, Provocation]
  const rows = (call: Call, provocations: Provocations): Row[] =>
    Object.entries(provocations).flatMap(([reason, list]) =>
      list === NEVER_SENT ? [] : list.map((p): Row => [call, reason as WorkspaceFailureReason, p.how, p])
    )
  const TABLES: Record<Call, Record<WorkspaceFailureReason, MessageKey | null>> = {
    unlock: UNLOCK_FAILURE_KEYS,
    create: CREATE_FAILURE_KEYS
  }
  const CHANNELS: Record<Call, string> = { unlock: IPC.unlockWorkspace, create: IPC.createWorkspace }
  const catalogValues = new Set(UI_LANGUAGE_CODES.flatMap((code) => Object.values(catalogOf(code))))

  it.each([...rows('unlock', UNLOCK), ...rows('create', CREATE)])(
    '%s %s (%s): main says what the gate shows, in every language main speaks',
    async (call, reason, _how, provocation) => {
      const { workspace, args } = provocation.arrange()
      registerWorkspaceIpc(ctxWith(workspace))
      const key = TABLES[call][reason]
      const before = mainUiLanguage()
      const messages: string[] = []
      try {
        for (const code of UI_LANGUAGE_CODES) {
          applyUiLanguageSetting(code)
          const { result } = await invoke(handlers, CHANNELS[call], ...args)
          expect(result).toMatchObject({ ok: false, reason })
          const { message } = result as Extract<WorkspaceActionResult, { ok: false }>
          if (key !== null) expect(message, code).toBe(tMain(key))
          messages.push(message)
        }
      } finally {
        applyUiLanguageSetting(before)
        if (workspace instanceof WorkspaceController) workspace.shutdown()
      }
      if (key === null) {
        // Free text: one sentence whatever language main speaks, and none the catalogs hold.
        expect(new Set(messages).size).toBe(1)
        expect(catalogValues.has(messages[0])).toBe(false)
      }
    }
  )
})
