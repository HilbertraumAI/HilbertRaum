import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'

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
// handler's WIRING is asserted at the IPC layer. Every lock row's ctx reads the live DB through the
// controller getter (`workspaceIpcCtx`), so each purges its own; the spy is mockClear'd before the
// assertion below.
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
import {
  MIN_PASSWORD_LENGTH,
  type PrivacyPolicy,
  type WorkspaceActionResult,
  type WorkspaceStateInfo
} from '../../src/shared/types'
import {
  RECOVERY_SUFFIX,
  WorkspaceController,
  VaultRecoveryBlockedError,
  createEncryptedVaultOnDisk,
  decryptFile,
  lockEncryptedVault,
  unlockEncryptedVault,
  type VaultPaths,
  type WorkingCopyLossCause
} from '../../src/main/services/workspace-vault'
import { basename, dirname, join } from 'node:path'
import { applyUiLanguageSetting, mainUiLanguage, tMain } from '../../src/main/services/i18n'
import { log, readLogTail } from '../../src/main/services/logging'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import * as settingsModule from '../../src/main/services/settings'
import { UI_LANGUAGE_CODES, t, type MessageKey } from '../../src/shared/i18n'
import {
  CREATE_FAILURE_KEYS,
  UNLOCK_FAILURE_KEYS,
  type WorkspaceFailureReason
} from '../../src/shared/workspace-failure-keys'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import {
  ENCRYPTION_REQUIRED,
  FAST_KDF,
  backdate,
  damagedVault,
  editDescriptor,
  failedLockState,
  freshVaultPaths,
  lockedVault,
  noisePastPageOne,
  newerPlaintext,
  plantProbeTrap,
  newerVault,
  setFrameMagic,
  tagFailingVault,
  unlockedController,
  upgradeBlockedVault,
  workspaceIpcCtx,
  type WorkspaceIpcCtxOptions
} from '../helpers/vault-fixtures'
import { buildToolRunner } from '../../src/main/services/skills/tool-runs'
import { SkillRunController } from '../../src/main/services/skills/run-controller'
import { seedStoredTextDoc } from '../helpers/doc-fixtures'
import { killableRuntime } from '../helpers/killable-runtime'
import { workspaceStandIn } from '../helpers/workspace-stand-in'
import { docTaskManager, docTaskRuntime, docTaskWorld, importWords, waitTerminal } from '../helpers/doctask-fixtures'

const handlers = ipcState.handlers as unknown as IpcHandlers
const PW = 'right-password'

/** A controller that ran `init()` over `vp`: its state is whatever the disk holds (and, given, the free space the drive
 *  reports, #892). */
function startedOn(
  vp: VaultPaths,
  policy: PrivacyPolicy = ENCRYPTION_REQUIRED,
  devMode = false,
  freeBytes?: (path: string) => number | null
): WorkspaceController {
  const ctrl = new WorkspaceController(vp, policy, devMode, undefined, freeBytes)
  ctrl.init()
  return ctrl
}

/** A fresh encrypted vault under `PW`, unlocked. */
const unlockedVault = (): WorkspaceController => unlockedController(lockedVault('wsipc', PW), PW)

/** #208's on-disk state: the password verifies and `.enc` authenticates, but holds 64 KiB of our own noise. */
const damagedOnDisk = (): VaultPaths => damagedVault(lockedVault('wsipc', PW), PW, 64 * 1024)

/** #911: a locked vault whose `.enc` something outside the app removed, with no working copy left to keep. */
function encRemoved(): VaultPaths {
  const vp = lockedVault('wsipc', PW)
  rmSync(vp.encPath)
  return vp
}

beforeEach(() => ipcState.handlers.clear())

describe('registerWorkspaceIpc', () => {
  // Main's own floors, at the boundary. The gate and the Settings card hold the same
  // MIN_PASSWORD_LENGTH (WorkspaceGate.test.tsx, ChangePassword.test.tsx), so they never send
  // main a password one short of it; only these rows reach main's checks there.
  it('create refuses an encrypted password one short of MIN_PASSWORD_LENGTH and creates one at it', async () => {
    const vp = freshVaultPaths('wsipc')
    const ctrl = startedOn(vp)
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    const short = await invoke(handlers, IPC.createWorkspace, 'a'.repeat(MIN_PASSWORD_LENGTH - 1), 'encrypted')
    expect(short.result).toEqual({
      ok: false,
      reason: 'refused',
      message: tMain('main.workspace.passwordTooShort', { min: MIN_PASSWORD_LENGTH })
    })
    expect(ctrl.isUnlocked()).toBe(false)
    // A normal result before any KDF: no vault was built, half or whole.
    expect(existsSync(vp.descriptorPath)).toBe(false)
    expect(existsSync(vp.encPath)).toBe(false)
    const atFloor = await invoke(handlers, IPC.createWorkspace, 'a'.repeat(MIN_PASSWORD_LENGTH), 'encrypted')
    expect(atFloor.result).toMatchObject({ ok: true, state: { state: 'unlocked', mode: 'encrypted' } })
    ctrl.lock()
  })

  it('change password refuses a new password one short of MIN_PASSWORD_LENGTH and takes one at it', async () => {
    const ctrl = unlockedVault()
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    try {
      const short = await invoke(handlers, IPC.changeWorkspacePassword, PW, 'a'.repeat(MIN_PASSWORD_LENGTH - 1))
      expect(short.result).toEqual({
        ok: false,
        reason: 'refused',
        message: tMain('main.workspace.newPasswordTooShort', { min: MIN_PASSWORD_LENGTH })
      })
      // The refusal left the vault alone: the current password still verifies for the change at the floor.
      const atFloor = await invoke(handlers, IPC.changeWorkspacePassword, PW, 'a'.repeat(MIN_PASSWORD_LENGTH))
      expect(atFloor.result).toMatchObject({ ok: true, state: { state: 'unlocked', mode: 'encrypted' } })
    } finally {
      ctrl.lock()
    }
  })

  // #860 L4: a change while document work holds the vault (an import writing `.enc` sidecars) is refused as busy, so
  // the user waits for the import; "change failed" would send them retrying into the same refusal. #807: in the
  // language main speaks, like the busy refusal beside it (the vault threw an English literal in every language).
  it('change password while documents are being imported is refused as busy in main’s language, the vault untouched', async () => {
    const vp = lockedVault('wsipc', PW)
    const ctrl = unlockedController(vp, PW)
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    const descriptor = readFileSync(vp.descriptorPath)
    const release = ctrl.beginDocumentWork()
    const before = mainUiLanguage()
    try {
      for (const code of UI_LANGUAGE_CODES) {
        applyUiLanguageSetting(code)
        const { result } = await invoke(handlers, IPC.changeWorkspacePassword, PW, 'long-enough-pw')
        expect(result, code).toEqual({ ok: false, reason: 'refused', message: t(code, 'main.workspace.busyDocumentWork') })
      }
      expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
    } finally {
      applyUiLanguageSetting(before)
      release()
      ctrl.lock()
    }
  })

  // #845: a change refused because the descriptor on disk is a newer build's says the change failed and the current
  // password still works; the gate's "update the app to open it" would be wrong on a workspace that is open.
  it('change password over a descriptor a newer build rewrote mid-session answers "change failed", the descriptor untouched', async () => {
    const vp = lockedVault('wsipc', PW)
    const ctrl = unlockedController(vp, PW)
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    editDescriptor(vp, (d) => {
      d.version = 3
    })
    const descriptor = readFileSync(vp.descriptorPath)
    try {
      const { result } = await invoke(handlers, IPC.changeWorkspacePassword, PW, 'long-enough-pw')
      expect(result).toEqual({ ok: false, reason: 'error', message: tMain('main.workspace.changeFailed') })
      expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
    } finally {
      ctrl.lock()
    }
  })

  it('an unlock on an already-open workspace answers its state and re-runs nothing: no unverified audit event (#858)', async () => {
    const audit = vi.fn()
    const ctrl = startedOn(lockedVault('wsipc', PW))
    registerWorkspaceIpc(workspaceIpcCtx(ctrl, { extra: { audit } }))
    try {
      // Control: the unlock from locked runs the post-unlock steps, the audit event among them.
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: true })
      expect(audit).toHaveBeenCalledWith('workspace_unlocked', expect.any(String))
      audit.mockClear()
      const again = await invoke(handlers, IPC.unlockWorkspace, 'not-the-password')
      expect(again.result).toEqual({ ok: true, state: ctrl.getState() })
      expect(ctrl.getState().state).toBe('unlocked')
      expect(audit).not.toHaveBeenCalled()
    } finally {
      ctrl.lock()
    }
  })

  // #936 review SF-2: the quit hold has one more release, an unlock. No quit is under way while someone unlocks, so a
  // hold still set then (a quit called off outside the close guard) would otherwise block every document task, and
  // the chat busy guard with it, for the rest of the session.
  it('an unlock clears a quit hold left set: the next document task runs (#936)', async () => {
    const w = docTaskWorld('wsipc-hold')
    const doc = await importWords(w, 50)
    const manager = docTaskManager(w, { getRuntime: () => docTaskRuntime() })
    manager.holdQueueForQuit()
    const ctrl = startedOn(lockedVault('wsipc', PW))
    registerWorkspaceIpc(workspaceIpcCtx(ctrl, { extra: { docTasks: manager } }))
    try {
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: true })
      const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [doc] })
      expect(manager.getDocTask(jobId).state).toBe('running')
      expect((await waitTerminal(manager, jobId)).state).toBe('done')
    } finally {
      ctrl.lock()
    }
  })

  // #955 item 4: the create seam had no release. A first-run create is no moment of a quit either, so a hold left set
  // before it kept every document task of the new workspace queued for the session.
  it('a create clears a quit hold left set: the next document task runs (#955 item 4)', async () => {
    const w = docTaskWorld('wsipc-hold')
    const doc = await importWords(w, 50)
    const manager = docTaskManager(w, { getRuntime: () => docTaskRuntime() })
    manager.holdQueueForQuit()
    const ctrl = startedOn(freshVaultPaths('wsipc'))
    registerWorkspaceIpc(workspaceIpcCtx(ctrl, { extra: { docTasks: manager } }))
    try {
      expect((await invoke(handlers, IPC.createWorkspace, 'brand-new-pw', 'encrypted')).result).toMatchObject({ ok: true })
      const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [doc] })
      expect(manager.getDocTask(jobId).state).toBe('running')
      expect((await waitTerminal(manager, jobId)).state).toBe('done')
    } finally {
      ctrl.lock()
    }
  })

  // M-S2: the renderer is the untrusted boundary — a non-string password must NOT throw
  // an unhandled TypeError at the IPC layer (password.length used to run before the try).
  it('handles a non-string create password as a clean refusal (no throw)', async () => {
    const ctrl = startedOn(freshVaultPaths('wsipc'))
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    // A throwing handler would reject this await — the no-throw guarantee IS the test.
    const { result } = await invoke(handlers, IPC.createWorkspace, 12345 as unknown as string, 'encrypted')
    expect(result).toMatchObject({ ok: false, reason: 'refused' })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  // The gate reads the state before any unlock (getStatus MUST work pre-unlock), so the locked row is the one that
  // catches a guard added to the handler; the plaintext row is the only IPC read of an open `plaintext_dev` workspace.
  it.each<[string, () => WorkspaceController, WorkspaceStateInfo]>([
    [
      'a locked encrypted vault, before any unlock',
      () => startedOn(lockedVault('wsipc', PW)),
      { state: 'locked', mode: 'encrypted', plaintextAllowed: false, encryptionRequired: true }
    ],
    [
      'an open plaintext_dev workspace',
      () => startedOn(freshVaultPaths('wsipc'), DEFAULT_POLICY, true), // dev → plaintext opens
      { state: 'unlocked', mode: 'plaintext_dev', plaintextAllowed: true, encryptionRequired: false }
    ]
  ])('returns the current workspace state: %s', async (_case, open, expected) => {
    const ctrl = open()
    try {
      registerWorkspaceIpc(workspaceIpcCtx(ctrl))
      const { result } = await invoke(handlers, IPC.getWorkspaceState)
      expect(result).toEqual(expected)
    } finally {
      ctrl.shutdown()
    }
  })

  // "Lock now" must leave nothing user-derived running: each boundary is torn down ONCE and while the DB is still
  // open (the fake records `isUnlocked()` at call time), i.e. before the vault re-encrypts. The embedder row has no
  // `suspend`, so it drives the `?? stop()` fallback the mock embedder takes. BE-5 (ocr-audit 2026-07-18): the idle
  // warm tesseract worker holds decoded page bytes in main-process RAM; the lock must `suspend()` it, never `stop()`
  // (stop() latches permanently, and the engine is held on ctx for the session). Every fake is async: a `suspend`
  // returning `undefined` would fall through `??` to its sibling.
  it.each<[string, (call: () => Promise<void>, latchingStop: () => Promise<void>) => WorkspaceIpcCtxOptions, boolean]>([
    ['the chat runtime', (call) => ({ stopRuntime: call }), false],
    ['the embedder through its stop fallback (no suspend)', (call) => ({ stopEmbedder: call }), false],
    ['the vision sidecar (its KV cache holds the image + prompt)', (call) => ({ stopVision: call }), false],
    [
      'the OCR engine through suspend, never its latching stop (BE-5)',
      (call, latchingStop) => ({ extra: { ocrEngine: { suspend: call, stop: latchingStop } } }),
      true
    ],
    // #860 L1: the reranker has seen recent questions and chunk text, and whisper-cli reads decrypted audio.
    [
      'the reranker through suspend, never its latching stop (#860 L1)',
      (call, latchingStop) => ({ extra: { reranker: { suspend: call, stop: latchingStop } } }),
      true
    ],
    [
      'the transcriber through suspend, never its latching stop (#860 L1)',
      (call, latchingStop) => ({ extra: { transcriber: { suspend: call, stop: latchingStop } } }),
      true
    ],
    // #860 L2: an embedder that has `suspend` is suspended; its latching `stop` would leave every embed after the next
    // unlock failing with "Embedder is stopped".
    [
      'the embedder through suspend when it has one, never its latching stop (#860 L2)',
      (call, latchingStop) => ({ suspendEmbedder: call, stopEmbedder: latchingStop }),
      true
    ]
  ])('lockWorkspace tears down %s while the DB is still open', async (_boundary, install, hasLatchingStop) => {
    const ctrl = unlockedVault()
    const atCall: boolean[] = []
    const call = vi.fn(async () => {
      atCall.push(ctrl.isUnlocked())
    })
    const latchingStop = vi.fn(async () => {})
    registerWorkspaceIpc(workspaceIpcCtx(ctrl, install(call, latchingStop)))

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(ctrl.isUnlocked()).toBe(false)
    expect(atCall).toEqual([true]) // once, before the vault re-encrypted
    if (hasLatchingStop) expect(latchingStop).not.toHaveBeenCalled()
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
    const ctrl = unlockedVault()
    const order: string[] = []
    const suspendTranslator = vi.fn(async () => {
      order.push('translator.suspend')
    })
    const stopTranslator = vi.fn(async () => {})
    const cancelAllDocTasks = vi.fn()
    const awaitActiveTaskSettled = vi.fn(async () => {})
    const abortActiveBuild = vi.fn()
    const stopTranslateJobs = vi.fn(async () => {
      order.push('translateJobs.stop')
    })
    registerWorkspaceIpc(
      workspaceIpcCtx(ctrl, {
        extra: {
          translator: { suspend: suspendTranslator, stop: stopTranslator },
          docTasks: { cancelAllDocTasks, awaitActiveTaskSettled, abortActiveBuild },
          translateJobs: { stop: stopTranslateJobs }
        }
      })
    )

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(abortActiveBuild).toHaveBeenCalledTimes(1)
    // TA-1 H2: the whole pipeline is flushed (running + queued), and the running task's
    // abort-unwind settle is awaited before the vault re-encrypts.
    expect(cancelAllDocTasks).toHaveBeenCalledTimes(1)
    expect(awaitActiveTaskSettled).toHaveBeenCalledTimes(1)
    // TG-4: the view job is aborted once, and BEFORE the translator suspend (its abort loop is
    // synchronous, so a queued next window can't reach translate() after the sidecar dies).
    expect(order).toEqual(['translateJobs.stop', 'translator.suspend'])
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
    const ctrl = unlockedVault()
    expect(ctrl.isUnlocked()).toBe(true)

    let unwind!: () => void
    const settled = { done: false }
    const base = workspaceIpcCtx(ctrl) as unknown as Record<string, unknown>
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

  // #860 L10: …but never longer than the shipped 5 s bound. An unwind that never ends (a handler wedged in a parser,
  // a skill run parked in a save dialog that was already open) must not hang "Lock now": at the bound the lock goes on
  // and forfeits only that task's own write. The clock is driven 1 ms short of the bound, then to it. The doc task's
  // bound is the handler's own race; a skill run's is the real controller's, which the handler hands the bound.
  it.each([
    [
      'doc-task',
      (base: Record<string, unknown>, reached: () => void) => {
        base.docTasks = {
          cancelAllDocTasks: vi.fn(),
          abortActiveBuild: vi.fn(),
          awaitActiveTaskSettled: () => {
            reached()
            return new Promise<void>(() => {})
          }
        }
      }
    ],
    [
      'skill-run',
      (base: Record<string, unknown>, reached: () => void) => {
        const runs = new SkillRunController()
        // A run that ignores its abort: it stays running for good.
        runs.start({ skillInstallId: 's', toolName: 'redact_document', documentId: 'doc-l10', documentCount: 1, runner: () => new Promise(() => {}) })
        const awaitSettled = runs.awaitSettled.bind(runs)
        runs.awaitSettled = (timeoutMs: number) => {
          reached()
          return awaitSettled(timeoutMs)
        }
        base.skillRuns = runs
      }
    ]
  ])('lockWorkspace stops waiting for a cancelled %s that never settles at the 5 s bound (#860 L10)', async (_lane, install) => {
    const ctrl = unlockedVault()
    const base = workspaceIpcCtx(ctrl) as unknown as Record<string, unknown>
    let reached!: () => void
    const settleAwaited = new Promise<void>((r) => (reached = r))
    install(base, reached)
    registerWorkspaceIpc(base as unknown as AppContext)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let done = false
      const lockP = invoke(handlers, IPC.lockWorkspace).then((r) => {
        done = true
        return r
      })
      await settleAwaited
      await vi.advanceTimersByTimeAsync(4_999)
      expect(done).toBe(false)
      expect(ctrl.isUnlocked()).toBe(true) // still waiting, the DB open
      await vi.advanceTimersByTimeAsync(1)
      const { result } = await lockP
      expect(result).toMatchObject({ state: 'locked' })
      expect(ctrl.isUnlocked()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // An optional service that fails to stop must never block the security action: the sidecars settle together
  // (allSettled), and the local API's stop, which runs first, on its own (#860 L8).
  it.each<[string, WorkspaceIpcCtxOptions]>([
    [
      'a sidecar stop fails (allSettled)',
      {
        stopRuntime: async () => {
          throw new Error('sidecar wedged')
        }
      }
    ],
    [
      'the local API stop fails (#860 L8)',
      {
        extra: {
          localApi: {
            stop: async () => {
              throw new Error('listener wedged')
            }
          }
        }
      }
    ]
  ])('lockWorkspace still locks when %s', async (_what, opts) => {
    const ctrl = unlockedVault()
    registerWorkspaceIpc(workspaceIpcCtx(ctrl, opts))
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('lockWorkspace purges the resident decoded-vector cache (RAG-6 security wiring, T2)', async () => {
    const ctrl = unlockedVault()
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

    // `ctx.db` is the production getter (`requireDb()` on every read): a purge moved after `lock()` throws here as
    // it would in the app. A static `db` on the ctx kept that green.
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    purgeSpy.mockClear() // ignore the earlier lock rows' purges of their own databases
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
    const ctrl = unlockedVault()
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
      registerWorkspaceIpc(workspaceIpcCtx(ctrl))
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
    const ctrl = unlockedVault()
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

    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    await expect(turn).resolves.toMatchObject({ content: 'Lighthouses guide ships', endedEarly: 'lock' })

    ctrl.unlock(PW)
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
    const ctrl = unlockedVault()
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
    registerWorkspaceIpc(
      workspaceIpcCtx(ctrl, {
        stopRuntime,
        extra: { skillRuns: runs, cancelBenchmark: () => order.push('benchmark.cancel') }
      })
    )
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })

    expect(runs.get(runHandle)?.state).toBe('cancelled')
    expect(saveTextFile).not.toHaveBeenCalled() // before #606: the rule-based copy's save dialog
    expect(order).toEqual(['benchmark.cancel', 'runtime.stop'])
    ctrl.unlock(PW)
    try {
      // Recorded before the vault re-encrypted (before #606 a late write failed: "could not be saved").
      expect(ctrl.requireDb().prepare('SELECT status FROM skill_runs').all()).toEqual([{ status: 'cancelled' }])
    } finally {
      ctrl.lock()
    }
  })
})

describe('a workspace put back under the create form (#954)', () => {
  // #954, #955 item 3 (main side): a key file copied back under an open create form. The create is refused, and the
  // state the lock screen re-reads says `locked`, so it shows its unlock form; that form then tells the truth: the
  // workspace's `.enc` is still elsewhere (the #911 copy), and once it is back the same session opens it.
  it('a key file put back under the create form: create refused, the state locked, and the workspace opens once complete (#954)', async () => {
    const vp = freshVaultPaths('wsipc')
    const ctrl = startedOn(vp)
    const other = lockedVault('wsipc', PW)
    copyFileSync(other.descriptorPath, vp.descriptorPath)
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    try {
      const { result } = await invoke(handlers, IPC.createWorkspace, 'brand-new-pw', 'encrypted')
      expect(result).toEqual({ ok: false, reason: 'workspace_exists', message: tMain('main.workspace.exists') })
      expect(((await invoke(handlers, IPC.getWorkspaceState)).result as WorkspaceStateInfo).state).toBe('locked')
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: false, reason: 'vault_missing' })
      copyFileSync(other.encPath, vp.encPath)
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: true })
    } finally {
      ctrl.shutdown()
    }
  })
})

// UI-languages owner call D-17 (a), and the wave's code review: the first-run gate shows a
// failed unlock or create in ITS language, from `reason`, with the key its tables
// (`shared/workspace-failure-keys.ts`) hold: a copy of the choice each branch of the handlers
// makes. The gate's own rows stub main's answer, so main moving a reason to another key would turn
// nothing red there while the gate kept showing the old copy. These rows drive the REAL handlers
// into every branch that answers each reason and hold main's `message` against the gate's table,
// once for every language main can speak (equal text in all of them stands in for the same key),
// with the `{ min }` the gate renders every key with. Since #807 every reason a call sends has a
// key: a table's `null` means the call never sends that reason, so a driven reason with a `null`
// would show main's text and put the screen in two languages again. Every row also leaves the
// workspace as it found it (still locked, still uninitialized, …): a refusal is a normal result
// the gate re-prompts on, never a changed state.
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

  const UNLOCK: Provocations = {
    wrong_password: [
      { how: 'a wrong password', arrange: () => ({ workspace: startedOn(lockedVault('wsipc', PW)), args: ['wrong-password'] }) },
      {
        how: 'a password that is not a string',
        arrange: () => ({ workspace: startedOn(lockedVault('wsipc', PW)), args: [{ evil: true }] })
      },
      // #208: on a vault whose data is damaged, a WRONG password still reads as a wrong password, not as damage.
      {
        how: 'a wrong password on a damaged vault',
        arrange: () => ({ workspace: startedOn(damagedOnDisk()), args: ['wrong-password'] })
      },
      // #911: the verifier is in the descriptor, so a wrong password is told apart with `.enc` gone too.
      {
        how: 'a wrong password on a vault whose .enc was removed',
        arrange: () => ({ workspace: startedOn(encRemoved()), args: ['wrong-password'] })
      }
    ],
    vault_damaged: [
      { how: 'a vault that decrypts to noise', arrange: () => ({ workspace: startedOn(damagedOnDisk()), args: [PW] }) },
      // #860 V5b: the password verified, so a tag failure means the `.enc` bytes changed (bit rot, a cut-short copy).
      {
        how: 'an .enc whose tag fails after the password verified',
        arrange: () => ({ workspace: startedOn(tagFailingVault(lockedVault('wsipc', PW))), args: [PW] })
      }
    ],
    // #911: the password verified, and there is no encrypted file to open and no copy to restore it from.
    vault_missing: [
      { how: 'an .enc removed with nothing left to keep', arrange: () => ({ workspace: startedOn(encRemoved()), args: [PW] }) }
    ],
    // #807 (C-S2): the encrypted file is there, but the descriptor that holds its wrapped key is not, or can't be read.
    // Answered for any password: the verifier is in that file.
    vault_descriptor_missing: [
      {
        how: 'an .enc whose config/workspace.json was removed',
        arrange: () => {
          const vp = lockedVault('wsipc', PW)
          rmSync(vp.descriptorPath)
          return { workspace: startedOn(vp), args: [PW] }
        }
      },
      {
        how: 'an .enc beside a config/workspace.json that is not JSON',
        arrange: () => {
          const vp = lockedVault('wsipc', PW)
          writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
          return { workspace: startedOn(vp), args: ['wrong-password'] }
        }
      }
    ],
    // #955 item 1: the key file is there but cannot be read, and no `.enc` is beside it. Answered for any password.
    vault_descriptor_unreadable: [
      {
        how: 'a config/workspace.json that is not JSON, with no .enc beside it',
        arrange: () => {
          const vp = freshVaultPaths('wsipc')
          writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
          return { workspace: startedOn(vp), args: [PW] }
        }
      }
    ],
    // #844: a healthy database whose open's upgrade step cannot finish is not damage.
    vault_open_failed: [
      {
        how: 'a database whose upgrade step cannot finish',
        arrange: () => ({ workspace: startedOn(upgradeBlockedVault(lockedVault('wsipc', PW), PW)), args: [PW] })
      }
    ],
    // A real hold takes an `fs` mock (vault-recovery-guards.test.ts drives one into this handler);
    // the handler only sees the controller's typed refusal, so a workspace whose unlock throws it
    // reaches the same branch.
    vault_recovery_blocked: [
      {
        how: 'a recovery file another program holds',
        arrange: () => ({
          workspace: {
            ...workspaceStandIn({ unlocked: false }), // the handler answers an open workspace before it unlocks (#858)
            unlock: () => {
              throw new VaultRecoveryBlockedError()
            }
          } as unknown as WorkspaceController,
          args: [PW]
        })
      }
    ],
    workspace_newer: [
      {
        how: 'a database a newer build stamped',
        arrange: () => ({ workspace: startedOn(newerVault(lockedVault('wsipc', PW), PW)), args: [PW] })
      },
      // #845: the vault format itself, refused before the password is checked.
      {
        how: 'a vault descriptor a newer build wrote',
        arrange: () => ({
          workspace: startedOn(
            editDescriptor(lockedVault('wsipc', PW), (d) => {
              d.version = 3
            })
          ),
          args: [PW]
        })
      },
      {
        how: 'an .enc frame a newer build wrote',
        arrange: () => {
          const vp = lockedVault('wsipc', PW)
          setFrameMagic(vp.encPath, 'HRAUMEN2')
          return { workspace: startedOn(vp), args: [PW] }
        }
      }
    ],
    workspace_exists: NEVER_SENT,
    plaintext_not_allowed: NEVER_SENT,
    refused: NEVER_SENT,
    error: [{ how: 'no vault to unlock', arrange: () => ({ workspace: startedOn(freshVaultPaths('wsipc')), args: [PW] }) }]
  }

  const CREATE: Provocations = {
    wrong_password: NEVER_SENT,
    vault_damaged: NEVER_SENT,
    vault_missing: NEVER_SENT,
    vault_descriptor_missing: NEVER_SENT,
    // Review V F-3: an unreadable key file that appeared under the create form, with no `.enc`: the unlock's refusal.
    vault_descriptor_unreadable: [
      {
        how: 'a config/workspace.json that is not JSON put under the create form, with no .enc',
        arrange: () => {
          const vp = freshVaultPaths('wsipc')
          const workspace = startedOn(vp)
          writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
          return { workspace, args: ['longenough', 'encrypted'] }
        }
      }
    ],
    vault_open_failed: NEVER_SENT,
    vault_recovery_blocked: NEVER_SENT,
    workspace_newer: [
      {
        how: 'a plaintext database a newer build stamped',
        arrange: () => ({
          workspace: startedOn(newerPlaintext(freshVaultPaths('wsipc')), DEFAULT_POLICY, true),
          args: ['', 'plaintext_dev']
        })
      }
    ],
    // #807: a workspace already on the drive (before, `refused` with the vault's English sentence). The renderer reads
    // the state once, so a vault that appears under an open create form gets here.
    workspace_exists: [
      {
        how: 'a vault already on the drive',
        arrange: () => ({ workspace: startedOn(lockedVault('wsipc', PW)), args: ['longenough', 'encrypted'] })
      },
      // #860 V4's state: the create flow stays away from an `.enc` whatever its descriptor holds.
      {
        how: 'an .enc beside a descriptor that is not JSON',
        arrange: () => {
          const vp = lockedVault('wsipc', PW)
          writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
          return { workspace: startedOn(vp), args: ['longenough', 'encrypted'] }
        }
      },
      // The belt behind `create()`'s own check (reached only by a race between the two): the real
      // `createEncryptedVaultOnDisk` over an `.enc`, through the handler's mapping.
      {
        how: 'the on-disk belt meeting an .enc',
        arrange: () => {
          const vp = lockedVault('wsipc', PW)
          return {
            workspace: {
              ...workspaceStandIn({ unlocked: false }),
              create: (password: string) => createEncryptedVaultOnDisk(vp, password, FAST_KDF)
            } as unknown as WorkspaceController,
            args: ['longenough', 'encrypted']
          }
        }
      }
    ],
    // #807: a create without a password that the policy, or a build outside developer mode, refuses (before, `refused`
    // with the vault's English sentence). The gate offers the switch only when allowed.
    plaintext_not_allowed: [
      {
        how: 'a plaintext workspace the policy forbids',
        arrange: () => ({
          workspace: startedOn(freshVaultPaths('wsipc'), ENCRYPTION_REQUIRED, true),
          args: ['whatever8', 'plaintext_dev']
        })
      },
      {
        how: 'a plaintext workspace outside developer mode',
        arrange: () => ({
          workspace: startedOn(freshVaultPaths('wsipc'), DEFAULT_POLICY, false),
          args: ['', 'plaintext_dev']
        })
      }
    ],
    // #807 A2: main's too-short refusal, the one `refused` create sends, rendered with `{ min }`. The gate's own floor
    // keeps it from being sent (WorkspaceGate.test.tsx, "enables Create exactly at the shared floor main enforces").
    refused: [
      {
        how: 'an encrypted password one short of the floor',
        arrange: () => ({
          workspace: startedOn(freshVaultPaths('wsipc')),
          args: ['a'.repeat(MIN_PASSWORD_LENGTH - 1), 'encrypted']
        })
      },
      {
        how: 'a password that is not a string',
        arrange: () => ({ workspace: startedOn(freshVaultPaths('wsipc')), args: [12345, 'encrypted'] })
      }
    ],
    error: [
      { how: 'an unknown mode', arrange: () => ({ workspace: startedOn(freshVaultPaths('wsipc')), args: ['longenough', 'bogus'] }) },
      {
        how: 'a workspace already open',
        arrange: () => ({ workspace: startedOn(freshVaultPaths('wsipc'), DEFAULT_POLICY, true), args: ['', 'plaintext_dev'] })
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

  it.each([...rows('unlock', UNLOCK), ...rows('create', CREATE)])(
    '%s %s (%s): main says what the gate shows, in every language main speaks',
    async (call, reason, _how, provocation) => {
      // A reason a call sends needs a key (#807): a `null` would show main's text in main's language.
      const key = TABLES[call][reason]
      expect(key, `${call} sends ${reason}, so its table needs a key`).not.toBeNull()
      const { workspace, args } = provocation.arrange()
      registerWorkspaceIpc(workspaceIpcCtx(workspace))
      // The stand-ins (recovery blocked, the create belt) have no state of their own to keep.
      const stateBefore = workspace instanceof WorkspaceController ? workspace.getState() : null
      const before = mainUiLanguage()
      try {
        for (const code of UI_LANGUAGE_CODES) {
          applyUiLanguageSetting(code)
          const { result } = await invoke(handlers, CHANNELS[call], ...args)
          expect(result).toMatchObject({ ok: false, reason })
          const { message } = result as Extract<WorkspaceActionResult, { ok: false }>
          // The gate renders every key with the password floor; keys without `{min}` ignore it.
          expect(message, code).toBe(tMain(key!, { min: MIN_PASSWORD_LENGTH }))
        }
        if (stateBefore !== null) expect(workspace.getState()).toEqual(stateBefore)
      } finally {
        applyUiLanguageSetting(before)
        if (workspace instanceof WorkspaceController) workspace.shutdown()
      }
    }
  )
})

// #875: a lock at quit that finished at the last snapshot can be recorded only once there is a database again. The
// unlock that consumes the notice writes it to Activity (the audit log) and app.log, once.
describe('the unlock after a loss of the last session’s changes (#875)', () => {
  /** The working file overwritten in place, then the app quits: the lock at quit finishes at the last snapshot. */
  const lostAtQuit = (vp: VaultPaths): void => {
    const before = unlockedController(vp, PW)
    before.requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE);')
    const size = statSync(vp.dbPath).size
    const fd = openSync(vp.dbPath, 'r+')
    try {
      writeSync(fd, randomBytes(size), 0, size, 0)
    } finally {
      closeSync(fd)
    }
    before.shutdown()
  }
  /** A failed lock's working file (newer than `.enc`, cleanly closed) whose pages past page 1 are noise: the next start
   *  sweeps it. */
  const discardedAtStart = (vp: VaultPaths): void => {
    failedLockState(vp, 7171, PW)
    noisePastPageOne(vp.dbPath)
  }
  /** A `.recovery` snapshot newer than `.enc` whose pages past page 1 are noise: the unlock shreds it. */
  const damagedRecovery = (vp: VaultPaths): void => {
    const { db, key } = unlockEncryptedVault(vp, PW)
    lockEncryptedVault(vp, db, key)
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    decryptFile(vp.encPath, recoveryPath, key)
    noisePastPageOne(recoveryPath)
    backdate(vp.encPath)
  }
  /** #892: the app ended mid-session without a lock (a power cut, the drive pulled, a kill): the session's working file,
   *  newer than `.enc`, beside its live `-wal`/`-shm`. The next start sweeps it. */
  const endedUnlocked = (vp: VaultPaths): void => {
    failedLockState(vp, 7171, PW)
    writeFileSync(`${vp.dbPath}-wal`, 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')
  }
  /** #892: a drive with no room for the lock's next snapshot (less free than the size of `.enc`). */
  const fullDrive = (): number => 0

  // The audit metadata goes verbatim into the plaintext activity-log export, so it is pinned whole: the cause, and for a
  // loss a marker recorded, when that was (the marker's mtime). A recovery copy is discarded at this unlock, so the
  // event's own time is when.
  // The log line names what was lost: the working file (a lock, a start), the recovery copy a failed lock left, or the
  // session the app ended without locking (#892).
  it.each<[string, (vp: VaultPaths) => void, WorkingCopyLossCause, WorkspaceStateInfo['lockNotice'] | null, string, ((path: string) => number | null)?]>([
    ['a lock at quit that finished at the last snapshot', lostAtQuit, 'lock', 'working_copy_lost', 'the working file was gone or no longer a database'],
    ['a start that swept the last session’s broken working file', discardedAtStart, 'startup', 'working_copy_lost', 'the working file was no longer a database'],
    ['an unlock that discarded a damaged recovery copy', damagedRecovery, 'recovery', null, 'the recovery copy a failed lock left was no longer a database'],
    ['a start that swept a session the app ended without locking', endedUnlocked, 'unclean', 'session_not_closed', 'the app ended without locking the workspace'],
    // What was measured, not the cause it suggests (a power cut on a drive that full logs the same, #892 review N-4).
    ['the same on a drive too full to lock', endedUnlocked, 'unclean-full', 'session_not_closed_full', 'the app ended without locking the workspace, and at the next start the free space on the drive was below the size of the workspace', fullDrive]
  ])('after %s, the unlock records workspace_working_copy_lost and one log line, once', async (_what, lose, cause, notice, what, drive) => {
    const vp = lockedVault('wsipc', PW)
    lose(vp)

    const ctrl = startedOn(vp, ENCRYPTION_REQUIRED, false, drive) // the next start
    registerWorkspaceIpc(workspaceIpcCtx(ctrl, { extra: { audit: createAuditRecorder(() => ctrl.requireDb()) } }))
    const markerFile = join(dirname(vp.descriptorPath), 'working-copy-lost.json')
    const noticeAtStart = notice !== null
    const lostAt = noticeAtStart ? statSync(markerFile).mtime.toISOString() : undefined
    const lostEvents = (): Array<Record<string, unknown> | null> =>
      listAuditEvents(ctrl.requireDb())
        .filter((e) => e.type === 'workspace_working_copy_lost')
        .map((e) => e.metadata)
    const marker = `#875 marker ${randomUUID()}`
    log.info(marker)
    const logged = (): string[] => {
      const all = readLogTail(100_000)
      return all.slice(all.findIndex((l) => l.includes(marker)) + 1).filter((l) => l.includes('since the last saved state were lost'))
    }
    try {
      const state = (await invoke(handlers, IPC.getWorkspaceState)).result
      if (noticeAtStart) expect(state).toMatchObject({ lockNotice: notice })
      else expect(state).not.toHaveProperty('lockNotice')
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: true, state: { state: 'unlocked' } })
      expect(lostEvents()).toEqual([noticeAtStart ? { cause, lostAt } : { cause }])
      expect(logged()).toHaveLength(1)
      expect(logged()[0]).toContain(`"cause":"${cause}"`)
      expect(logged()[0]).toContain(`were lost: ${what} {`) // the whole phrase, up to the metadata

      await invoke(handlers, IPC.lockWorkspace)
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: true })
      expect(lostEvents()).toHaveLength(1)
      expect(logged()).toHaveLength(1)
    } finally {
      ctrl.shutdown()
    }
  })
})

// #911 (owner decision D5: a log line, no audit type): the unlock that encrypts the copy a start kept over a missing
// `.enc` leaves the one durable trace that something removed the file. Content-free, once, and only then: the same
// roll-forward over an `.enc` that is there (a failed lock and quit, CODE-1b) says nothing.
describe('the unlock that restores a missing encrypted file (#911)', () => {
  it.each<[string, boolean]>([
    ['.enc removed after a failed lock and quit', true],
    ['.enc still there after a failed lock and quit', false]
  ])('%s: the unlock logs the restore only when .enc was missing', async (_what, removed) => {
    const vp = lockedVault('wsipc', PW)
    failedLockState(vp, 7171, PW)
    if (removed) rmSync(vp.encPath)
    const workspace = startedOn(vp)
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    const marker = `#911 marker ${randomUUID()}`
    log.info(marker)
    const logged = (): string[] => {
      const all = readLogTail(100_000)
      return all.slice(all.findIndex((l) => l.includes(marker)) + 1).filter((l) => l.includes('encrypted workspace file was missing'))
    }
    try {
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: true, state: { state: 'unlocked' } })
      expect(logged()).toHaveLength(removed ? 1 : 0)
      if (removed) expect(logged()[0]).not.toContain('hilbertraum.sqlite')
      await invoke(handlers, IPC.lockWorkspace)
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: true })
      expect(logged()).toHaveLength(removed ? 1 : 0)
    } finally {
      workspace.shutdown()
    }
  })
})

// #911 code review: the unlock that shreds a kept copy it cannot restore (damaged, with no `.enc`) logs that once,
// content-free; an unlock with nothing kept says only that the file is missing.
describe('the unlock that removes a kept copy it cannot restore (#911)', () => {
  it.each<[string, boolean]>([
    ['a kept copy damaged before the unlock', true],
    ['no copy kept', false]
  ])('%s: the vault_missing unlock logs the removed copy only when there was one', async (_what, damagedCopy) => {
    const vp = lockedVault('wsipc', PW)
    if (damagedCopy) failedLockState(vp, 7171, PW)
    rmSync(vp.encPath)
    const workspace = startedOn(vp)
    if (damagedCopy) noisePastPageOne(`${vp.dbPath}${RECOVERY_SUFFIX}`)
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    const marker = `#911 removed-copy marker ${randomUUID()}`
    log.info(marker)
    try {
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: false, reason: 'vault_missing' })
      const all = readLogTail(100_000)
      const logged = all
        .slice(all.findIndex((l) => l.includes(marker)) + 1)
        .filter((l) => l.includes('a kept copy that could not be restored was removed'))
      expect(logged).toHaveLength(damagedCopy ? 1 : 0)
      if (damagedCopy) expect(logged[0]).not.toContain('hilbertraum.sqlite')
    } finally {
      workspace.shutdown()
    }
  })
})

// #876 review round 2: a site whose probe could not read the structure (not damage) judged the file by its header, as
// before the probe existed. Support needs to know that happened: the lock handler logs which site and SQLite's code.
describe('a lock whose probe fell back to the header (#876)', () => {
  it('logs the site and the SQLite code', async () => {
    const ctrl = unlockedVault()
    plantProbeTrap(ctrl.requireDb())
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    const marker = `#876 fallback marker ${randomUUID()}`
    log.info(marker)
    try {
      expect((await invoke(handlers, IPC.lockWorkspace)).result).toMatchObject({ state: 'locked' })
      const all = readLogTail(100_000)
      const lines = all.slice(all.findIndex((l) => l.includes(marker)) + 1).filter((l) => l.includes('judged by its SQLite header'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('"site":"lock"')
      expect(lines[0]).toMatch(/"code":"sqlite 1\b/)
    } finally {
      ctrl.shutdown()
    }
  })
})

// #845: the user copy is the same for a newer database and a newer vault format; only the log tells support which
// artifact a newer build wrote, and which version it found.
describe('an unlock refused for a newer vault format (#845)', () => {
  it('logs the artifact and the version found', async () => {
    const workspace = startedOn(
      editDescriptor(lockedVault('wsipc', PW), (d) => {
        d.version = 3
      })
    )
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    const marker = `#845 marker ${randomUUID()}`
    log.info(marker)
    try {
      const { result } = await invoke(handlers, IPC.unlockWorkspace, PW)
      expect(result).toMatchObject({ ok: false, reason: 'workspace_newer' })
      const all = readLogTail(100_000)
      const logged = all
        .slice(all.findIndex((l) => l.includes(marker)) + 1)
        .filter((l) => l.includes('vault format was written by a newer build'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('{"what":"descriptor","found":3}')
    } finally {
      workspace.shutdown()
    }
  })

  // #860 V5b: the damaged copy is one for both kinds of damage; the log names which.
  it('a vault_damaged unlock logs which damage: a failed authentication after the password verified', async () => {
    const workspace = startedOn(tagFailingVault(lockedVault('wsipc', PW)))
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    const marker = `#860 V5b marker ${randomUUID()}`
    log.info(marker)
    try {
      const { result } = await invoke(handlers, IPC.unlockWorkspace, PW)
      expect(result).toMatchObject({ ok: false, reason: 'vault_damaged' })
      const all = readLogTail(100_000)
      const logged = all.slice(all.findIndex((l) => l.includes(marker)) + 1).filter((l) => l.includes('vault damaged'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('{"damage":"failed-authentication"}')
    } finally {
      workspace.shutdown()
    }
  })
})

// #844: an open that could not finish is logged by what failed, never by the failure's message. A
// backfill's error can quote what it was reading (a JSON parse error quotes its input), and app.log
// never carries document text (logging.ts). The trigger's abort text stands in for such a quote.
describe('an unlock whose open could not finish (#844)', () => {
  it('logs the cause’s kind and SQLite’s own description, never the cause’s message', async () => {
    const quote = 'page text the backfill was reading'
    const workspace = startedOn(upgradeBlockedVault(lockedVault('wsipc', PW), PW, { abortMessage: quote }))
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    // Only this unlock's lines: the table rows above log the same failure, and the buffer trims
    // from the front, so the lines are taken after a marker rather than by count.
    const marker = `#844 marker ${randomUUID()}`
    log.info(marker)
    try {
      const { result } = await invoke(handlers, IPC.unlockWorkspace, PW)
      expect(result).toMatchObject({ ok: false, reason: 'vault_open_failed' })
      const all = readLogTail(100_000)
      const lines = all.slice(all.findIndex((l) => l.includes(marker)) + 1)
      const logged = lines.filter((l) => l.includes('could not finish opening'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('ERR_SQLITE_ERROR')
      expect(logged[0]).toContain('constraint failed')
      expect(lines.join('\n')).not.toContain(quote)
    } finally {
      workspace.shutdown()
    }
  })

  it('a create whose first open could not finish logs what failed, not only the fixed message', async () => {
    const workspace = startedOn(freshVaultPaths('wsipc'))
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    // Creating builds and seeds the vault first, then opens it like an unlock: the second seed is the open's.
    const realSeed = settingsModule.seedSettings
    const full = Object.assign(new Error('database or disk is full'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 13,
      errstr: 'database or disk is full'
    })
    const seed = vi
      .spyOn(settingsModule, 'seedSettings')
      .mockImplementationOnce(realSeed)
      .mockImplementationOnce(() => {
        throw full
      })
    const marker = `#844 create marker ${randomUUID()}`
    log.info(marker)
    try {
      const { result } = await invoke(handlers, IPC.createWorkspace, 'longenough', 'encrypted')
      expect(result).toMatchObject({ ok: false, reason: 'error' })
      const all = readLogTail(100_000)
      const logged = all.slice(all.findIndex((l) => l.includes(marker)) + 1).filter((l) => l.includes('Workspace create failed'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('"sqliteCode":13')
    } finally {
      seed.mockRestore()
      workspace.shutdown()
    }
  })
})

// #807 review round. The production bundle can hold a second copy of workspace-vault, whose classes then fail
// `instanceof` (the bundle-duplication quirk the handlers name); vitest never sees that, so each typed arm's `err.name`
// half gets a row of its own: an error that is only named like the class maps to the same reason.
describe('the typed workspace refusals are recognised by name too (#807)', () => {
  const named = (name: string): Error => Object.assign(new Error('x'), { name })

  it.each<[string, 'create' | 'unlock', WorkspaceFailureReason, MessageKey]>([
    ['WorkspaceExistsError', 'create', 'workspace_exists', 'main.workspace.exists'],
    ['PlaintextNotAllowedError', 'create', 'plaintext_not_allowed', 'main.workspace.plaintextNotAllowed'],
    ['VaultDescriptorMissingError', 'unlock', 'vault_descriptor_missing', 'main.workspace.descriptorMissing'],
    ['VaultDescriptorUnreadableError', 'unlock', 'vault_descriptor_unreadable', 'main.workspace.descriptorUnreadable'],
    ['VaultDescriptorUnreadableError', 'create', 'vault_descriptor_unreadable', 'main.workspace.descriptorUnreadable']
  ])('a %s from another copy of the module answers %s %s', async (name, call, reason, key) => {
    const thrower = (): never => {
      throw named(name)
    }
    const workspace = {
      ...workspaceStandIn({ unlocked: false }),
      ...(call === 'create' ? { create: thrower } : { unlock: thrower })
    } as unknown as WorkspaceController
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    const { result } =
      call === 'create'
        ? await invoke(handlers, IPC.createWorkspace, 'longenough', 'encrypted')
        : await invoke(handlers, IPC.unlockWorkspace, PW)
    expect(result).toEqual({ ok: false, reason, message: tMain(key) })
  })
})

// #807 review round: a failed create's log line keeps the cause of an error that is not a Node file error (a bug in a
// post-create step, a `TypeError`), while a file error logs only its code and system call (no path: the EPERM row in
// vault-recovery-guards.test.ts).
describe('the log line of a create that failed for another reason than a file error (#807)', () => {
  it('names the error and its message', async () => {
    const cause = "Cannot read properties of undefined (reading 'lastBenchmark')"
    const workspace = {
      ...workspaceStandIn({ unlocked: false }),
      create: (): never => {
        throw new TypeError(cause)
      }
    } as unknown as WorkspaceController
    registerWorkspaceIpc(workspaceIpcCtx(workspace))
    const marker = `#807 create marker ${randomUUID()}`
    log.info(marker)
    const { result } = await invoke(handlers, IPC.createWorkspace, 'longenough', 'encrypted')
    expect(result).toEqual({ ok: false, reason: 'error', message: tMain('main.workspace.createFailed') })
    const all = readLogTail(100_000)
    const logged = all.slice(all.findIndex((l) => l.includes(marker)) + 1).filter((l) => l.includes('Workspace create failed'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('"error":"TypeError"')
    expect(logged[0]).toContain(JSON.stringify(cause).slice(1, -1))
  })
})

// #956: the unlock, password-change and lock arms logged `String(err)`, and a Node file error's text names the drive's
// or the profile's absolute paths, which Diagnostics → Copy and Save log hand out. Each arm now logs `failureForLog`
// (its rule is failure-for-log.test.ts's): these rows hold the wiring, each with a real file error (a directory where a
// temp file goes) or a stand-in that throws what Node throws.
describe('a workspace failure line names no path (#956)', () => {
  /** The log lines written after `marker` that contain `needle`. */
  function linesAfter(marker: string, needle: string): string[] {
    const all = readLogTail(100_000)
    return all.slice(all.findIndex((l) => l.includes(marker)) + 1).filter((l) => l.includes(needle))
  }
  /** Neither `root`, its JSON-escaped spelling (a Windows path inside a JSON log field), nor its own folder name is in
   *  `line`. `readLogTail` redacts what it hands out (#975): under a Windows profile the account segment no longer
   *  matches, so only the folder name, which the redaction keeps, still shows that a path reached the log. */
  const namesNoPath = (line: string, root: string): boolean =>
    !line.includes(root) && !line.includes(JSON.stringify(root).slice(1, -1)) && !line.includes(basename(root))
  /** What Node throws for a file operation: code, syscall, path, and a message naming the path. */
  const nodeFileError = (code: string, syscall: string, path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: failed, ${syscall} '${path}'`), { code, syscall, path, errno: -1 })
  const mark = (): string => {
    const marker = `#956 marker ${randomUUID()}`
    log.info(marker)
    return marker
  }

  it('an unlock whose roll-forward meets a file error logs its code, not the path', async () => {
    const vp = lockedVault('wsipc', PW)
    failedLockState(vp, 7171, PW) // a working file newer than `.enc`: the start keeps it, the unlock re-encrypts it
    const ctrl = startedOn(vp)
    mkdirSync(`${vp.encPath}.tmp`) // encryptFile's temp: EISDIR, Node's error naming the path
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    const marker = mark()
    try {
      expect((await invoke(handlers, IPC.unlockWorkspace, PW)).result).toMatchObject({ ok: false, reason: 'error' })
      const lines = linesAfter(marker, 'Workspace unlock failed')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('EISDIR')
      expect(namesNoPath(lines[0], vp.root)).toBe(true)
    } finally {
      ctrl.shutdown()
    }
  })

  it('a password change whose key file write meets a file error logs its code, not the path', async () => {
    const vp = lockedVault('wsipc', PW)
    const ctrl = unlockedController(vp, PW)
    mkdirSync(`${vp.descriptorPath}.tmp`) // writeVaultDescriptor's temp: EISDIR
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    const marker = mark()
    try {
      const { result } = await invoke(handlers, IPC.changeWorkspacePassword, PW, 'another-password')
      expect(result).toEqual({ ok: false, reason: 'error', message: tMain('main.workspace.changeFailed') })
      const lines = linesAfter(marker, 'Workspace password change failed')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('EISDIR')
      expect(namesNoPath(lines[0], vp.root)).toBe(true)
    } finally {
      ctrl.lock()
    }
  })

  // The lock's four settle steps never throw by their callees' contracts (`awaitActiveTaskSettled` swallows,
  // `awaitSettled` "never rejects"); a stand-in that breaks the contract with a file error reaches each arm.
  it.each<[string, string, (error: Error) => Record<string, unknown>]>([
    [
      'document-task',
      'Error awaiting doc-task settle on lock',
      (error) => ({
        docTasks: {
          abortActiveBuild: () => {},
          cancelAllDocTasks: () => {},
          awaitActiveTaskSettled: () => {
            throw error
          }
        }
      })
    ],
    [
      'skill-run',
      'Error settling skill runs on lock',
      (error) => ({ skillRuns: { cancelAll: () => {}, awaitSettled: async () => Promise.reject(error) } })
    ],
    [
      'plaintext-operation',
      'Error settling plaintext operations on lock',
      (error) => ({
        plaintextOps: { abortAll: () => {}, size: () => 0, sweepRegistered: () => 0, awaitSettled: async () => Promise.reject(error) }
      })
    ],
    [
      'knowledge-pack',
      'Error settling knowledge-pack operations on lock',
      (error) => ({
        zimOps: { abortAll: () => {}, size: () => 0, sweepRegistered: () => 0, awaitSettled: async () => Promise.reject(error) }
      })
    ]
  ])('a lock whose %s settle throws a file error logs its code, not the path', async (_step, needle, extra) => {
    const vp = lockedVault('wsipc', PW)
    const ctrl = unlockedController(vp, PW)
    const error = nodeFileError('EBUSY', 'unlink', join(dirname(vp.dbPath), 'documents', 'held.parse'))
    registerWorkspaceIpc(workspaceIpcCtx(ctrl, { extra: extra(error) }))
    const marker = mark()
    expect((await invoke(handlers, IPC.lockWorkspace)).result).toMatchObject({ state: 'locked' })
    const lines = linesAfter(marker, needle)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('EBUSY')
    expect(namesNoPath(lines[0], vp.root)).toBe(true)
  })

  // S-5: the failed lock's line said only "Could not lock the workspace"; the cause support needs was dropped.
  it('a failed lock logs what caused it (ENOSPC), still with no path (S-5)', async () => {
    const vp = lockedVault('wsipc', PW)
    const fullDrive = (_src: string, dest: string): void => {
      throw nodeFileError('ENOSPC', 'write', `${dest}.tmp`)
    }
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false, fullDrive)
    ctrl.init()
    ctrl.unlock(PW)
    registerWorkspaceIpc(workspaceIpcCtx(ctrl))
    const marker = mark()
    try {
      await expect(invoke(handlers, IPC.lockWorkspace)).rejects.toThrow(tMain('main.workspace.lockFailed'))
      const lines = linesAfter(marker, 'Workspace lock failed')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('"code":"ENOSPC"')
      expect(namesNoPath(lines[0], vp.root)).toBe(true)
    } finally {
      try {
        ctrl.shutdown() // open again after the failed lock; the seam fails this lock too
      } catch {
        /* expected: VaultLockError */
      }
    }
  })
})
