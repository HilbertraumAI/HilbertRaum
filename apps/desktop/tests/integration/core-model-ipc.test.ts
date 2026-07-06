import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

// IPC-layer tests for registerCoreIpc + registerModelIpc: the locked-workspace network
// fallback (the offline ceiling must hold pre-unlock, when allowNetwork is unreadable) and
// the model handler guards (no manifests dir → empty list; unknown model id → throw).

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  clipboardText: null as string | null,
  clipboardThrows: false
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' },
  clipboard: {
    writeText: (text: string) => {
      if (ipcState.clipboardThrows) throw new Error('clipboard unavailable')
      ipcState.clipboardText = text
    }
  }
}))

import { registerCoreIpc } from '../../src/main/ipc/registerCoreIpc'
import { maybeAutoStartActiveModel, registerModelIpc } from '../../src/main/ipc/registerModelIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import type { AppStatus, ModelInfo, WorkspaceStateInfo } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const REPO_MANIFESTS = join(process.cwd(), '..', '..', 'model-manifests')

function seededDb(): Db {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-coreipc-')), 'test.sqlite'))
  seedSettings(db)
  return db
}

function bogusConfigDir(): string {
  return join(tmpdir(), 'hilbertraum-no-such-config-dir')
}

beforeEach(() => {
  ipcState.handlers.clear()
  ipcState.clipboardText = null
  ipcState.clipboardThrows = false
})

describe('registerCoreIpc', () => {
  it('getAppStatus keeps the offline ceiling while the workspace is locked', async () => {
    const lockedWorkspace = {
      isUnlocked: () => false,
      getState: (): WorkspaceStateInfo => ({
        state: 'locked',
        mode: null,
        plaintextAllowed: false,
        encryptionRequired: true
      })
    }
    const ctx = {
      paths: { configPath: bogusConfigDir() },
      workspace: lockedWorkspace
    } as unknown as AppContext
    registerCoreIpc(ctx)

    const { result } = await invoke(handlers, IPC.getAppStatus)
    const status = result as AppStatus
    // No policy file + locked DB → deny-by-default ceiling: offline, no network, not ready.
    expect(status.offlineMode).toBe(true)
    expect(status.networkAllowed).toBe(false)
    expect(status.workspaceReady).toBe(false)
    expect(status.activeModelId).toBeNull()
    expect(status.hardwareProfile).toBe('UNKNOWN')
  })

  it('writeClipboard writes text via the MAIN clipboard module and reports success', async () => {
    const ctx = { paths: {}, workspace: { isUnlocked: () => false } } as unknown as AppContext
    registerCoreIpc(ctx)

    const { result } = await invoke(handlers, IPC.writeClipboard, 'copy me')
    expect(result).toBe(true)
    expect(ipcState.clipboardText).toBe('copy me')
  })

  it('writeClipboard returns false (never throws) when the clipboard write fails', async () => {
    const ctx = { paths: {}, workspace: { isUnlocked: () => false } } as unknown as AppContext
    registerCoreIpc(ctx)
    ipcState.clipboardThrows = true

    const { result } = await invoke(handlers, IPC.writeClipboard, 'copy me')
    expect(result).toBe(false)
  })
})

describe('registerModelIpc', () => {
  // F16 (audit-postmerge-2026-06-29): the DB-touching model handlers now require an unlocked
  // workspace. These fixtures predate that guard and omit `workspace`; default them to unlocked
  // (the locked-refusal behaviour is enumerated separately in ipc-lock-coverage.test.ts).
  const reg = (ctx: AppContext): void =>
    registerModelIpc({ workspace: { isUnlocked: () => true }, ...(ctx as object) } as AppContext)

  // Model handlers resolve the drive policy from `paths.configPath` (M10); a missing
  // config dir means "no policy file" → developer-friendly defaults.
  const noWeightPaths = (): { rootPath: string; configPath: string } => ({
    rootPath: join(tmpdir(), 'hilbertraum-no-weights'),
    configPath: bogusConfigDir()
  })

  // A config dir carrying a dev-friendly policy.json (allows unverified models). Used to
  // exercise developer leniency now that a MISSING policy.json on a packaged build fails
  // CLOSED to the strict posture (M-4) — leniency requires a policy that permits it.
  const devPolicyConfigDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-devpolicy-'))
    writeFileSync(
      join(dir, 'policy.json'),
      JSON.stringify({
        workspace: { encryption_required: false, allow_plaintext_dev_mode: true },
        models: { allow_unverified_models: true, require_manifest: true, require_sha256_match: false }
      })
    )
    return dir
  }

  it('returns an empty model list when no manifests directory is configured', async () => {
    const ctx = { db: seededDb(), manifestsDir: null } as unknown as AppContext
    reg(ctx)
    const { result } = await invoke(handlers, IPC.listModels)
    expect(result).toEqual([])
  })

  it('lists the committed manifests and reports their state', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: false,
      runtime: { activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    const { result } = await invoke(handlers, IPC.listModels)
    const models = result as ModelInfo[]
    // The committed manifests are discovered; with no weights on disk they are 'missing'.
    expect(models.length).toBeGreaterThanOrEqual(4)
    expect(models.every((m) => typeof m.id === 'string')).toBe(true)
    // Not a developer (toggle off, packaged build) → no mock-start affordance (M10).
    expect(models.every((m) => m.startableAsMock !== true)).toBe(true)
  })

  it('startRuntime throws on an unknown model id', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: false,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'definitely-not-a-real-model')).rejects.toThrow(
      /Unknown model id/
    )
  })

  // H6 (audit round 4): the zero-weights first-run journey — a MISSING chat model may be
  // started by a developer (toggle or dev build; the selecting factory then yields the
  // mock runtime), so a fresh clone can actually chat. Everything else is gated in MAIN.
  it('startRuntime allows a missing chat model for a developer (mock fallback)', async () => {
    let startedWith: unknown = null
    const db = seededDb()
    updateSettings(db, { developerMode: true }) // explicit opt-in (default is now false, M10)
    const ctx = {
      db,
      manifestsDir: REPO_MANIFESTS,
      // A drive whose policy permits unverified models — leniency now needs both a
      // developer AND a permitting policy (M-4 fail-closed neutralizes M-6).
      paths: { rootPath: join(tmpdir(), 'hilbertraum-no-weights'), configPath: devPolicyConfigDir() },
      isDev: false,
      runtime: {
        start: async (o: unknown) => {
          startedWith = o
          return { running: true, modelId: 'qwen3-4b-instruct-q4', port: null, healthy: true, message: 'ok' }
        },
        activeModelId: () => null
      }
    } as unknown as AppContext
    reg(ctx)
    await invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')
    expect(startedWith).not.toBeNull()
  })

  it('refuses the mock fallback on a PACKAGED build with no policy.json (M-4 fail-closed)', async () => {
    // developerMode is ON, but a packaged build (isDev:false) with a missing policy.json
    // now fails closed to the strict posture (allow_unverified_models:false), so the
    // unverified mock fallback is NOT granted — neutralizing M-6.
    const db = seededDb()
    updateSettings(db, { developerMode: true })
    const ctx = {
      db,
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(), // missing config dir → no policy.json
      isDev: false,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')).rejects.toThrow(
      /can't be started/
    )
  })

  it('a dev build counts as developer even with the toggle off (isDev)', async () => {
    let started = false
    const ctx = {
      db: seededDb(), // developerMode defaults to FALSE (M10)
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: true,
      runtime: {
        start: async () => {
          started = true
          return { running: true, modelId: 'qwen3-4b-instruct-q4', port: null, healthy: true, message: 'ok' }
        },
        activeModelId: () => null
      }
    } as unknown as AppContext
    reg(ctx)
    await invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')
    expect(started).toBe(true)
  })

  it('startRuntime refuses a missing model for a non-developer', async () => {
    const ctx = {
      db: seededDb(), // developerMode defaults to false
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: false,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')).rejects.toThrow(
      /can't be started/
    )
  })

  // M10: the drive POLICY is authoritative — a commercial policy.json disables developer
  // leniency (and thus the mock fallback) even when the toggle/dev build says developer.
  it('a commercial policy vetoes developer leniency (no mock fallback)', async () => {
    const configPath = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-'))
    writeFileSync(
      join(configPath, 'policy.json'),
      JSON.stringify({
        models: { allow_unverified_models: false, require_sha256_match: true }
      }),
      'utf8'
    )
    const db = seededDb()
    updateSettings(db, { developerMode: true })
    const ctx = {
      db,
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: join(tmpdir(), 'hilbertraum-no-weights'), configPath },
      isDev: true,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')).rejects.toThrow(
      /can't be started/
    )
  })

  it('startRuntime rejects an embeddings model (the chat runtime loads chat models only)', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: true,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'multilingual-e5-small-q8')).rejects.toThrow(
      /not a chat model/
    )
  })

  // Post-MVP RAM gate: installed weights that exceed this machine's memory are refused
  // with a friendly error (the UI also disables the buttons; this guards auto-start and
  // non-UI callers). The mock fallback (missing weights) is NOT gated — it uses no RAM.
  it('startRuntime refuses installed weights that need more RAM than this machine has', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-ramgate-'))
    const manifestsDir = join(root, 'model-manifests')
    mkdirSync(manifestsDir, { recursive: true })
    writeFileSync(
      join(manifestsDir, 'huge.yaml'),
      stringify({
        id: 'huge-model',
        display_name: 'Huge Model',
        family: 'qwen3',
        role: 'chat',
        format: 'gguf',
        runtime: 'llama_cpp',
        license: 'apache-2.0',
        size_on_disk_gb: 999,
        recommended_min_ram_gb: 9999, // no real machine passes
        recommended_ram_gb: 9999,
        recommended_context_tokens: 4096,
        local_path: 'models/chat/huge.gguf',
        sha256: 'REPLACE_WITH_REAL_HASH',
        recommended_profiles: ['PRO'],
        license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
      })
    )
    mkdirSync(join(root, 'models', 'chat'), { recursive: true })
    writeFileSync(join(root, 'models', 'chat', 'huge.gguf'), 'weights') // present → installed (dev leniency)

    const ctx = {
      db: seededDb(),
      manifestsDir,
      paths: { rootPath: root, configPath: bogusConfigDir() },
      isDev: true,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'huge-model')).rejects.toThrow(
      /needs at least 9999 GB RAM/
    )
  })

  // Phase 20: getRuntimeStatus enriches the running model with its manifest's
  // supports_thinking_mode flag (the renderer gates the Deep answer mode on it).
  it('getRuntimeStatus reports supportsThinkingMode for the running model', async () => {
    const status = {
      running: true,
      modelId: 'qwen3-4b-instruct-q4',
      port: 1234,
      healthy: true,
      message: 'ok'
    }
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: true,
      runtime: { status: () => ({ ...status }), activeModelId: () => status.modelId }
    } as unknown as AppContext
    reg(ctx)

    const { result } = await invoke(handlers, IPC.getRuntimeStatus)
    // All four bundled Qwen3 chat manifests declare supports_thinking_mode: true.
    expect(result).toMatchObject({ running: true, supportsThinkingMode: true })
  })

  it('getRuntimeStatus leaves the thinking flag absent when stopped or unknown', async () => {
    const stopped = { running: false, modelId: null, port: null, healthy: false, message: 'Stopped' }
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: true,
      runtime: { status: () => ({ ...stopped }), activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)

    const { result } = await invoke(handlers, IPC.getRuntimeStatus)
    expect((result as { supportsThinkingMode?: boolean }).supportsThinkingMode).toBeUndefined()
  })

  it('verifyModel reports the fresh install state and throws on an unknown id', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: true,
      runtime: { activeModelId: () => null }
    } as unknown as AppContext
    reg(ctx)
    const { result } = await invoke(handlers, IPC.verifyModel, 'qwen3-4b-instruct-q4')
    expect(result).toBe('missing') // no weights on disk in this fixture
    await expect(invoke(handlers, IPC.verifyModel, 'nope')).rejects.toThrow(/Unknown model id/)
  })

  // Beta #27 (D70): the Models screen's collapsed "Use this model" action = select + start in one
  // MAIN-side handler. It must BOTH persist the active chat slot AND start the runtime, while the
  // §7.4 install gate + the RAM gate still refuse and a non-chat role is rejected before any persist.
  describe('useModel — collapse select + start (beta #27, D70)', () => {
    it('persists the active selection AND starts the runtime', async () => {
      let started = false
      const db = seededDb()
      const audited: string[] = []
      const ctx = {
        db,
        manifestsDir: REPO_MANIFESTS,
        paths: noWeightPaths(),
        isDev: true, // dev leniency → the missing-weights chat model mock-starts
        audit: (kind: string) => audited.push(kind),
        runtime: {
          start: async () => {
            started = true
            return { running: true, modelId: 'qwen3-4b-instruct-q4', port: null, healthy: true, message: 'ok' }
          },
          activeModelId: () => null
        }
      } as unknown as AppContext
      reg(ctx)
      await invoke(handlers, IPC.useModel, 'qwen3-4b-instruct-q4')
      // BOTH halves happened: the runtime started AND the choice is persisted as the active model.
      expect(started).toBe(true)
      expect(getSettings(db).activeModelId).toBe('qwen3-4b-instruct-q4')
      // One event chain: model_selected then runtime_started (the start emits its own).
      expect(audited).toEqual(['model_selected', 'runtime_started'])
    })

    it('aborts a yielding deep-index build before starting (mirrors startRuntime)', async () => {
      let aborted = false
      const ctx = {
        db: seededDb(),
        manifestsDir: REPO_MANIFESTS,
        paths: noWeightPaths(),
        isDev: true,
        docTasks: { abortActiveBuild: () => { aborted = true } },
        runtime: {
          start: async () => ({ running: true, modelId: 'qwen3-4b-instruct-q4', port: null, healthy: true, message: 'ok' }),
          activeModelId: () => null
        }
      } as unknown as AppContext
      reg(ctx)
      await invoke(handlers, IPC.useModel, 'qwen3-4b-instruct-q4')
      expect(aborted).toBe(true)
    })

    it('the install gate still refuses a not-installed model for a non-developer (does not start)', async () => {
      let started = false
      const ctx = {
        db: seededDb(), // developerMode defaults to false → no mock fallback
        manifestsDir: REPO_MANIFESTS,
        paths: noWeightPaths(),
        isDev: false,
        runtime: { start: async () => { started = true; return {} }, activeModelId: () => null }
      } as unknown as AppContext
      reg(ctx)
      await expect(invoke(handlers, IPC.useModel, 'qwen3-4b-instruct-q4')).rejects.toThrow(
        /can't be started/
      )
      expect(started).toBe(false)
    })

    it('the RAM gate still refuses installed weights that need more RAM (does not start)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'hilbertraum-usemodel-ram-'))
      const manifestsDir = join(root, 'model-manifests')
      mkdirSync(manifestsDir, { recursive: true })
      writeFileSync(
        join(manifestsDir, 'huge.yaml'),
        stringify({
          id: 'huge-model',
          display_name: 'Huge Model',
          family: 'qwen3',
          role: 'chat',
          format: 'gguf',
          runtime: 'llama_cpp',
          license: 'apache-2.0',
          size_on_disk_gb: 999,
          recommended_min_ram_gb: 9999, // no real machine passes
          recommended_ram_gb: 9999,
          recommended_context_tokens: 4096,
          local_path: 'models/chat/huge.gguf',
          sha256: 'REPLACE_WITH_REAL_HASH',
          recommended_profiles: ['PRO'],
          license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
        })
      )
      mkdirSync(join(root, 'models', 'chat'), { recursive: true })
      writeFileSync(join(root, 'models', 'chat', 'huge.gguf'), 'weights') // present → installed (dev leniency)
      let started = false
      const ctx = {
        db: seededDb(),
        manifestsDir,
        paths: { rootPath: root, configPath: bogusConfigDir() },
        isDev: true,
        runtime: { start: async () => { started = true; return {} }, activeModelId: () => null }
      } as unknown as AppContext
      reg(ctx)
      await expect(invoke(handlers, IPC.useModel, 'huge-model')).rejects.toThrow(
        /needs at least 9999 GB RAM/
      )
      expect(started).toBe(false)
    })

    it('rejects a non-chat role BEFORE persisting any selection', async () => {
      let started = false
      const db = seededDb()
      const ctx = {
        db,
        manifestsDir: REPO_MANIFESTS,
        paths: noWeightPaths(),
        isDev: true,
        runtime: { start: async () => { started = true; return {} }, activeModelId: () => null }
      } as unknown as AppContext
      reg(ctx)
      await expect(invoke(handlers, IPC.useModel, 'multilingual-e5-small-q8')).rejects.toThrow(
        /not a chat model/
      )
      expect(started).toBe(false)
      // The upfront role guard runs before selectModel — the chat slot is untouched (no embeddings
      // slot side effect either).
      expect(getSettings(db).activeModelId).toBeNull()
    })
  })
})

// Post-MVP: a restarted app showed an "active" model whose runtime was not running until
// the user manually pressed Start on the Models screen. maybeAutoStartActiveModel brings
// it up in the background once the workspace is usable — and must never throw/block.
describe('maybeAutoStartActiveModel', () => {
  function autoStartCtx(opts: {
    db: Db
    unlocked?: boolean
    runningModelId?: string | null
    onStart?: () => void
  }): AppContext {
    return {
      db: opts.db,
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: join(tmpdir(), 'hilbertraum-no-weights'), configPath: bogusConfigDir() },
      isDev: true, // developer leniency → the missing-weights model may start (mock fallback)
      workspace: { isUnlocked: () => opts.unlocked !== false },
      runtime: {
        start: async () => {
          opts.onStart?.()
          return { running: true, modelId: 'x', port: null, healthy: true, message: 'ok' }
        },
        activeModelId: () => opts.runningModelId ?? null
      }
    } as unknown as AppContext
  }

  it('starts the persisted active model in the background', async () => {
    const db = seededDb()
    updateSettings(db, { activeModelId: 'qwen3-4b-instruct-q4' })
    let resolveStarted!: () => void
    const started = new Promise<void>((r) => (resolveStarted = r))
    maybeAutoStartActiveModel(autoStartCtx({ db, onStart: resolveStarted }))
    await started // resolves only if the runtime start was actually invoked
  })

  it('does nothing without an active model, when disabled, when locked, or when already running', async () => {
    let starts = 0
    const onStart = (): void => {
      starts += 1
    }

    // No active model selected.
    maybeAutoStartActiveModel(autoStartCtx({ db: seededDb(), onStart }))

    // Toggle off.
    const dbOff = seededDb()
    updateSettings(dbOff, { activeModelId: 'qwen3-4b-instruct-q4', autoStartActiveModel: false })
    maybeAutoStartActiveModel(autoStartCtx({ db: dbOff, onStart }))

    // Workspace locked.
    const dbLocked = seededDb()
    updateSettings(dbLocked, { activeModelId: 'qwen3-4b-instruct-q4' })
    maybeAutoStartActiveModel(autoStartCtx({ db: dbLocked, unlocked: false, onStart }))

    // A runtime is already up — keep it.
    const dbRunning = seededDb()
    updateSettings(dbRunning, { activeModelId: 'qwen3-4b-instruct-q4' })
    maybeAutoStartActiveModel(autoStartCtx({ db: dbRunning, runningModelId: 'other', onStart }))

    await new Promise((r) => setTimeout(r, 50)) // let any stray background start land
    expect(starts).toBe(0)
  })
})
