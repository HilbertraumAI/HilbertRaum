import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'

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

import { randomUUID } from 'node:crypto'
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
import { WorkspaceController, VaultRecoveryBlockedError, type VaultPaths } from '../../src/main/services/workspace-vault'
import { applyUiLanguageSetting, mainUiLanguage, tMain } from '../../src/main/services/i18n'
import { UI_LANGUAGE_CODES, type MessageKey } from '../../src/shared/i18n'
import {
  CREATE_FAILURE_KEYS,
  UNLOCK_FAILURE_KEYS,
  type WorkspaceFailureReason
} from '../../src/shared/workspace-failure-keys'
import { catalogOf } from '../helpers/i18n-catalogs'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import {
  ENCRYPTION_REQUIRED,
  damagedVault,
  freshVaultPaths,
  lockedVault,
  newerPlaintext,
  newerVault,
  unlockedController,
  workspaceIpcCtx,
  type WorkspaceIpcCtxOptions
} from '../helpers/vault-fixtures'
import { buildToolRunner } from '../../src/main/services/skills/tool-runs'
import { SkillRunController } from '../../src/main/services/skills/run-controller'
import { seedStoredTextDoc } from '../helpers/doc-fixtures'
import { killableRuntime } from '../helpers/killable-runtime'

const handlers = ipcState.handlers as unknown as IpcHandlers
const PW = 'right-password'

/** A controller that ran `init()` over `vp`: its state is whatever the disk holds. */
function startedOn(vp: VaultPaths, policy: PrivacyPolicy = ENCRYPTION_REQUIRED, devMode = false): WorkspaceController {
  const ctrl = new WorkspaceController(vp, policy, devMode)
  ctrl.init()
  return ctrl
}

/** A fresh encrypted vault under `PW`, unlocked. */
const unlockedVault = (): WorkspaceController => unlockedController(lockedVault('wsipc', PW), PW)

/** #208's on-disk state: the password verifies and `.enc` authenticates, but holds 64 KiB of our own noise. */
const damagedOnDisk = (): VaultPaths => damagedVault(lockedVault('wsipc', PW), PW, 64 * 1024)

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

  it('lockWorkspace still locks when a sidecar stop fails (allSettled)', async () => {
    const ctrl = unlockedVault()
    registerWorkspaceIpc(
      workspaceIpcCtx(ctrl, {
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

// UI-languages owner call D-17 (a), and the wave's code review: the first-run gate shows a
// failed unlock or create in ITS language, from `reason`, with the key its tables
// (`shared/workspace-failure-keys.ts`) hold: a copy of the choice each branch of the handlers
// makes. The gate's own rows stub main's answer, so main moving a reason to another key would turn
// nothing red there while the gate kept showing the old copy. These rows drive the REAL handlers
// into every branch that answers each reason and hold main's `message` against the gate's table,
// once for every language main can speak (equal text in all of them stands in for the same key).
// Where a table holds `null` the gate shows main's `message` as it came, which keeps the screen in
// one language only while that message is free text: the same in every language, and no catalog
// value. Every row also leaves the workspace as it found it (still locked, still uninitialized, …):
// a refusal is a normal result the gate re-prompts on, never a changed state.
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
      }
    ],
    vault_damaged: [
      { how: 'a vault that decrypts to noise', arrange: () => ({ workspace: startedOn(damagedOnDisk()), args: [PW] }) }
    ],
    // A real hold takes an `fs` mock (vault-recovery-guards.test.ts drives one into this handler);
    // the handler only sees the controller's typed refusal, so a workspace whose unlock throws it
    // reaches the same branch.
    vault_recovery_blocked: [
      {
        how: 'a recovery file another program holds',
        arrange: () => ({
          workspace: {
            isUnlocked: () => false, // the handler answers an open workspace before it unlocks (#858)
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
      }
    ],
    refused: NEVER_SENT,
    error: [{ how: 'no vault to unlock', arrange: () => ({ workspace: startedOn(freshVaultPaths('wsipc')), args: [PW] }) }]
  }

  const CREATE: Provocations = {
    wrong_password: NEVER_SENT,
    vault_damaged: NEVER_SENT,
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
    // Not a row: main's too-short refusal (a password under MIN_PASSWORD_LENGTH, or not a string),
    // which does carry a catalog sentence. The gate never sends one (WorkspaceGate.test.tsx,
    // "enables Create exactly at the shared floor main enforces").
    refused: [
      {
        how: 'a plaintext workspace the policy forbids',
        arrange: () => ({
          workspace: startedOn(freshVaultPaths('wsipc'), ENCRYPTION_REQUIRED, true),
          args: ['whatever8', 'plaintext_dev']
        })
      },
      {
        how: 'a vault already on the drive',
        arrange: () => ({ workspace: startedOn(lockedVault('wsipc', PW)), args: ['longenough', 'encrypted'] })
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
  const catalogValues = new Set(UI_LANGUAGE_CODES.flatMap((code) => Object.values(catalogOf(code))))

  it.each([...rows('unlock', UNLOCK), ...rows('create', CREATE)])(
    '%s %s (%s): main says what the gate shows, in every language main speaks',
    async (call, reason, _how, provocation) => {
      const { workspace, args } = provocation.arrange()
      registerWorkspaceIpc(workspaceIpcCtx(workspace))
      const key = TABLES[call][reason]
      // The recovery-blocked stand-in has no state of its own to keep.
      const stateBefore = workspace instanceof WorkspaceController ? workspace.getState() : null
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
        if (stateBefore !== null) expect(workspace.getState()).toEqual(stateBefore)
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
